import { DatePipe } from "@angular/common";
import { Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ApiService, errorMessage, type Me, type RosterRow, type SeasonRow, type ShiftView } from "../api.service";
import { CurrentUserService } from "../current-user.service";

type Tab = "season" | "new" | "sync" | "import";

interface Roster {
  shift: ShiftView & { occupied: number };
  roster: RosterRow[];
}
interface Audit {
  checkedAt: string;
  mismatches: number;
  dishonest: number;
  rows: { signupId: string; volunteer: string; shift: string; desired: string; actual: string[]; appStatus: string; verdict: string; honest: boolean }[];
}
interface ReportEntry {
  severity: string;
  code: string;
  subject: string;
  message: string;
  resolution: string;
}

const SYNC_LABEL: Record<string, string> = {
  synced: "✓ on calendar",
  pending: "queued",
  retrying: "retrying",
  failed: "failed",
  drift: "calendar edited",
  not_connected: "no calendar",
  none: "—",
};

@Component({
  selector: "hl-coordinator-page",
  imports: [FormsModule, DatePipe],
  template: `
    @if (me()?.role === "volunteer") {
      <p class="text-stone-600">You're signed in as a volunteer. Pick Rosa or Malik in the switcher to coordinate.</p>
    } @else {
      <div class="flex flex-wrap items-end justify-between gap-3">
        <h1 class="text-2xl font-semibold tracking-tight">Season</h1>
        <nav class="flex gap-1 text-sm">
          @for (t of tabs; track t.id) {
            <button class="rounded-md px-3 py-1.5" [class]="tab() === t.id ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : 'hover:bg-stone-200 dark:hover:bg-stone-800'" (click)="tab.set(t.id)">{{ t.label }}</button>
          }
        </nav>
      </div>

      @switch (tab()) {
        @case ("season") {
          <div class="mt-4 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <section>
              <label class="flex items-center gap-2 text-xs text-stone-500"><input type="checkbox" [ngModel]="showPast()" (ngModelChange)="showPast.set($event)" /> show past shifts</label>
              <ul class="mt-2 max-h-[75vh] divide-y divide-stone-200 overflow-auto rounded-lg border border-stone-200 bg-white dark:divide-stone-800 dark:border-stone-800 dark:bg-stone-900">
                @for (o of seasonVisible(); track o.id) {
                  <li>
                    <button class="w-full px-3 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-800" [class.bg-teal-50]="selectedId() === o.id" [class.dark:bg-teal-950]="selectedId() === o.id" (click)="select(o.id)">
                      <div class="flex items-baseline justify-between gap-2">
                        <span class="font-medium" [class.line-through]="o.status === 'cancelled'">{{ o.title }}</span>
                        <span class="text-xs tabular-nums text-stone-500">{{ o.confirmed + o.uncertain + o.offered }}/{{ o.capacity }}</span>
                      </div>
                      <div class="text-xs text-stone-600 dark:text-stone-400">{{ o.kitchenTime }}</div>
                      <div class="mt-1 flex flex-wrap gap-1">
                        @if (o.status === "cancelled") {
                          <span class="badge bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300">cancelled{{ o.note ? " · " + o.note : "" }}</span>
                        }
                        @if (o.movedFrom) {
                          <span class="badge bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">moved</span>
                        }
                        @if (o.waitlisted) {
                          <span class="badge bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300">{{ o.waitlisted }} waitlisted</span>
                        }
                        @if (o.offered) {
                          <span class="badge bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300">{{ o.offered }} offer out</span>
                        }
                        @if (o.uncertain) {
                          <span class="badge bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100">❓ {{ o.uncertain }}</span>
                        }
                        @for (k of syncKeys(o); track k) {
                          <span class="badge" [class]="k === 'failed' || k === 'drift' ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300'">{{ o.sync[k] }} {{ syncLabel(k) }}</span>
                        }
                      </div>
                    </button>
                  </li>
                }
              </ul>
            </section>

            <section>
              @if (roster(); as r) {
                <div class="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
                  <div class="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h2 class="text-lg font-semibold">{{ r.shift.title }}</h2>
                      <div class="text-sm">{{ r.shift.kitchenTime }}</div>
                      @if (r.shift.movedFrom) {
                        <div class="text-xs text-amber-700 dark:text-amber-400">Moved, originally {{ r.shift.movedFrom }}</div>
                      }
                      <div class="text-xs text-stone-500">{{ r.shift.occupied }} of {{ r.shift.capacity }} seats held · refreshes every 2 s</div>
                    </div>
                    @if (r.shift.status === "scheduled") {
                      <div class="flex gap-2">
                        <button class="btn-secondary" (click)="mode.set(mode() === 'move' ? null : 'move')">Move…</button>
                        <button class="btn-danger" (click)="mode.set(mode() === 'cancel' ? null : 'cancel')">Cancel shift…</button>
                      </div>
                    }
                  </div>

                  @if (mode() === "move") {
                    <form class="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-stone-50 p-3 text-sm dark:bg-stone-800" (ngSubmit)="move()">
                      <label class="flex flex-col">Date <input class="field" type="date" name="d" [(ngModel)]="moveForm.date" required /></label>
                      <label class="flex flex-col">Start (CT) <input class="field" type="time" name="s" [(ngModel)]="moveForm.localStart" required /></label>
                      <label class="flex flex-col">End (CT) <input class="field" type="time" name="e" [(ngModel)]="moveForm.localEnd" required /></label>
                      <button class="btn-primary" type="submit">Move this one shift</button>
                      <p class="basis-full text-xs text-stone-500">Only this date moves; the rest of the series is untouched. Everyone signed up is notified, and connected calendars are updated.</p>
                    </form>
                  }
                  @if (mode() === "cancel") {
                    <form class="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-red-50 p-3 text-sm dark:bg-red-950/40" (ngSubmit)="cancel()">
                      <label class="flex flex-1 flex-col">Reason (shown to volunteers) <input class="field" name="n" [(ngModel)]="cancelNote" maxlength="200" placeholder="e.g. Kitchen inspection" /></label>
                      <button class="btn-danger" type="submit">Cancel {{ r.roster.length ? "and notify " + activeCount(r) : "" }}</button>
                    </form>
                  }
                  @if (actionMessage()) {
                    <p class="mt-2 text-sm" [class]="actionMessage()!.startsWith('✓') ? 'text-teal-700 dark:text-teal-400' : 'text-red-700 dark:text-red-400'">{{ actionMessage() }}</p>
                  }

                  <div class="mt-4 flex flex-wrap gap-3 text-xs">
                    @for (g of groups(r); track g.label) {
                      <span><strong>{{ g.n }}</strong> {{ g.label }}</span>
                    }
                  </div>
                  <div class="mt-2 overflow-x-auto">
                    <table class="w-full text-left text-sm">
                      <thead class="text-xs uppercase text-stone-500">
                        <tr><th class="py-1 pr-2">Volunteer</th><th class="pr-2">Status</th><th class="pr-2">Calendar</th>@if (r.shift.movedFrom) {<th>Saw move</th>}<th></th></tr>
                      </thead>
                      <tbody class="divide-y divide-stone-100 dark:divide-stone-800">
                        @for (p of r.roster; track p.signupId) {
                          <tr [class.opacity-50]="!isActive(p.status)">
                            <td class="py-1.5 pr-2">
                              <div>{{ p.name }} <span class="text-xs text-stone-400">{{ p.volunteerId }}</span></div>
                              @if (p.localTime) {
                                <div class="text-xs text-stone-500">their time: {{ p.localTime.split(" · ")[1] }}</div>
                              }
                              @if (p.tzSource !== "seed") {
                                <div class="text-xs text-amber-700 dark:text-amber-400">time zone {{ p.tzSource }}</div>
                              }
                            </td>
                            <td class="pr-2">
                              <span [class]="statusClass(p.status)">{{ statusLabel(p) }}</span>
                              @if (p.status === "offered" && p.offerExpiresLabel) {
                                <div class="text-xs text-stone-500">held until {{ p.offerExpiresLabel }}</div>
                              }
                              @if (p.chase) {
                                <div class="text-xs font-medium text-red-700 dark:text-red-400">no answer in 24 h, follow up</div>
                              }
                            </td>
                            <td class="pr-2 text-xs">
                              <span [class]="p.calendar.status === 'failed' || p.calendar.status === 'drift' ? 'text-red-700 dark:text-red-400' : p.calendar.status === 'retrying' ? 'text-amber-700 dark:text-amber-400' : ''" [title]="p.calendar.lastError ?? ''">
                                {{ calendarText(p) }}
                              </span>
                            </td>
                            @if (r.shift.movedFrom) {
                              <td class="pr-2 text-xs">{{ p.moveAcknowledged === null || !isActive(p.status) ? "" : p.moveAcknowledged ? "✓" : "not yet" }}</td>
                            }
                            <td class="text-right">
                              @if (p.calendar.status === "failed" || p.calendar.status === "drift") {
                                <button class="text-xs underline" (click)="retry(p)">{{ p.calendar.status === "drift" ? "Re-push shift time" : "Retry now" }}</button>
                              }
                              @if (isActive(p.status) && r.shift.status === "scheduled") {
                                <button class="ml-2 text-xs text-stone-500 underline" (click)="removeSignup(p)">remove</button>
                              }
                            </td>
                          </tr>
                        } @empty {
                          <tr><td colspan="5" class="py-3 text-stone-500">Nobody signed up yet.</td></tr>
                        }
                      </tbody>
                    </table>
                  </div>
                </div>
              } @else {
                <p class="text-sm text-stone-500">Select a shift to see its roster.</p>
              }
            </section>
          </div>
        }

        @case ("new") {
          <form class="mt-4 grid max-w-xl gap-3 rounded-lg border border-stone-200 bg-white p-4 text-sm dark:border-stone-800 dark:bg-stone-900" (ngSubmit)="createSeries()">
            <label class="flex flex-col gap-1">Title <input class="field" name="title" [(ngModel)]="seriesForm.title" required placeholder="e.g. Friday Pantry Sort" /></label>
            <div class="flex gap-4">
              <label class="flex items-center gap-1"><input type="radio" name="rec" value="weekly" [(ngModel)]="seriesForm.recurrence" /> Weekly</label>
              <label class="flex items-center gap-1"><input type="radio" name="rec" value="once" [(ngModel)]="seriesForm.recurrence" /> One-off</label>
            </div>
            @if (seriesForm.recurrence === "weekly") {
              <div class="flex flex-wrap gap-3">
                <label class="flex flex-col gap-1">Every
                  <select class="field" name="wd" [(ngModel)]="seriesForm.weekday">
                    @for (d of weekdays; track d.v) {
                      <option [value]="d.v">{{ d.l }}</option>
                    }
                  </select>
                </label>
                <label class="flex flex-col gap-1">From <input class="field" type="date" name="rs" [(ngModel)]="seriesForm.rangeStart" /></label>
                <label class="flex flex-col gap-1">Through <input class="field" type="date" name="re" [(ngModel)]="seriesForm.rangeEnd" /></label>
              </div>
            } @else {
              <label class="flex flex-col gap-1">Date <input class="field" type="date" name="date" [(ngModel)]="seriesForm.date" /></label>
            }
            <div class="flex flex-wrap gap-3">
              <label class="flex flex-col gap-1">Start (kitchen time, CT) <input class="field" type="time" name="ls" [(ngModel)]="seriesForm.localStart" /></label>
              <label class="flex flex-col gap-1">End <input class="field" type="time" name="le" [(ngModel)]="seriesForm.localEnd" /></label>
              <label class="flex flex-col gap-1">Capacity <input class="field w-24" type="number" min="1" name="cap" [(ngModel)]="seriesForm.capacity" /></label>
            </div>
            <p class="text-xs text-stone-500">Times are wall-clock in Central and stay put across daylight-saving changes.</p>
            <div><button class="btn-primary" type="submit">Create series</button></div>
            @if (actionMessage()) {
              <p [class]="actionMessage()!.startsWith('✓') ? 'text-teal-700 dark:text-teal-400' : 'text-red-700 dark:text-red-400'">{{ actionMessage() }}</p>
            }
          </form>
        }

        @case ("sync") {
          <section class="mt-4 space-y-4">
            <div class="flex flex-wrap gap-3">
              @for (k of summaryKeys(); track k) {
                <div class="rounded-lg border border-stone-200 bg-white px-4 py-2 dark:border-stone-800 dark:bg-stone-900">
                  <div class="text-2xl font-semibold tabular-nums">{{ summary()[k] }}</div>
                  <div class="text-xs text-stone-500">{{ syncLabel(k) }}</div>
                </div>
              }
            </div>
            <div class="rounded-lg border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 class="font-semibold">Compare with Tidewater</h2>
                  <p class="text-xs text-stone-500">Reads the simulator's actual state and checks every calendar link against what the app wants. "Dishonest" means the app says synced while the calendar disagrees. It should always be 0.</p>
                </div>
                <button class="btn-primary" (click)="runAudit()">Run check</button>
              </div>
              @if (audit(); as a) {
                <p class="mt-3 text-sm">
                  Checked {{ a.rows.length }} links at {{ a.checkedAt | date: "mediumTime" }}:
                  <strong [class.text-red-700]="a.mismatches">{{ a.mismatches }} mismatches</strong>
                  (expected while retries are in flight), <strong [class.text-red-700]="a.dishonest">{{ a.dishonest }} dishonest</strong>.
                </p>
                @if (a.mismatches) {
                  <table class="mt-2 w-full text-left text-xs">
                    <thead class="text-stone-500"><tr><th>Volunteer</th><th>Shift</th><th>Verdict</th><th>App says</th></tr></thead>
                    <tbody>
                      @for (row of auditProblems(); track row.signupId) {
                        <tr><td>{{ row.volunteer }}</td><td>{{ row.shift }}</td><td>{{ row.verdict }}</td><td>{{ row.appStatus }}</td></tr>
                      }
                    </tbody>
                  </table>
                }
              }
            </div>
          </section>
        }

        @case ("import") {
          <section class="mt-4">
            <p class="text-sm text-stone-600 dark:text-stone-400">Everything the spreadsheet import changed, assumed, or wants a human to look at.</p>
            <table class="mt-3 w-full text-left text-sm">
              <thead class="text-xs uppercase text-stone-500"><tr><th class="pr-2">Level</th><th class="pr-2">What</th><th class="pr-2">Found</th><th>What we did</th></tr></thead>
              <tbody class="divide-y divide-stone-200 dark:divide-stone-800">
                @for (e of report(); track $index) {
                  <tr class="align-top">
                    <td class="py-1.5 pr-2"><span class="badge" [class]="e.severity === 'warning' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' : e.severity === 'error' ? 'bg-red-100 text-red-800' : 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300'">{{ e.severity }}</span></td>
                    <td class="pr-2 text-xs"><div class="font-mono">{{ e.code }}</div><div class="text-stone-500">{{ e.subject }}</div></td>
                    <td class="pr-2">{{ e.message }}</td>
                    <td class="text-stone-600 dark:text-stone-400">{{ e.resolution }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }
    }
  `,
})
export class CoordinatorPage {
  private api = inject(ApiService);
  private user = inject(CurrentUserService);
  protected tabs: { id: Tab; label: string }[] = [
    { id: "season", label: "Shifts & rosters" },
    { id: "new", label: "New series" },
    { id: "sync", label: "Calendar sync" },
    { id: "import", label: "Import report" },
  ];
  protected weekdays = [
    { v: "MO", l: "Monday" },
    { v: "TU", l: "Tuesday" },
    { v: "WE", l: "Wednesday" },
    { v: "TH", l: "Thursday" },
    { v: "FR", l: "Friday" },
    { v: "SA", l: "Saturday" },
    { v: "SU", l: "Sunday" },
  ];
  protected tab = signal<Tab>("season");
  protected me = signal<Me | null>(null);
  protected season = signal<SeasonRow[]>([]);
  protected showPast = signal(false);
  protected selectedId = signal<string | null>(null);
  protected roster = signal<Roster | null>(null);
  protected mode = signal<"move" | "cancel" | null>(null);
  protected actionMessage = signal<string | null>(null);
  protected summary = signal<Record<string, number>>({});
  protected audit = signal<Audit | null>(null);
  protected report = signal<ReportEntry[]>([]);
  protected moveForm = { date: "", localStart: "", localEnd: "" };
  protected cancelNote = "";
  protected seriesForm = { title: "", recurrence: "weekly" as "weekly" | "once", weekday: "FR", rangeStart: "2026-10-30", rangeEnd: "2026-12-18", date: "2026-11-06", localStart: "10:00", localEnd: "12:00", capacity: 6 };

  protected seasonVisible = computed(() => this.season().filter((o) => this.showPast() || !o.past));
  protected summaryKeys = computed(() => Object.keys(this.summary()).sort());
  protected auditProblems = computed(() => this.audit()?.rows.filter((r) => r.verdict !== "ok") ?? []);

  constructor() {
    effect(() => {
      if (this.user.selectedId() && this.user.users().coordinators.length) void this.loadAll();
    });
    effect(() => {
      const t = this.tab();
      if (t === "import") void this.api.get<{ entries: ReportEntry[] }>("/import-report").then((r) => this.report.set(r.entries));
      if (t === "sync") void this.loadSummary();
    });
    const t = setInterval(() => void this.poll(), 2000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  protected syncKeys = (o: SeasonRow) => Object.keys(o.sync).filter((k) => k !== "not_connected");
  protected syncLabel = (k: string) => SYNC_LABEL[k] ?? k;
  protected isActive = (s: string) => ["confirmed", "waitlisted", "offered", "uncertain"].includes(s);
  protected activeCount = (r: Roster) => r.roster.filter((p) => this.isActive(p.status)).length;

  protected statusLabel(p: RosterRow) {
    switch (p.status) {
      case "confirmed":
        return "confirmed";
      case "waitlisted":
        return `waitlist #${p.waitlistPosition}`;
      case "offered":
        return "offered, awaiting answer";
      case "uncertain":
        return "❓ removed from calendar";
      case "cancelled_by_org":
        return "cancelled (shift)";
      default:
        return p.cancelReason?.replaceAll("_", " ") ?? p.status;
    }
  }
  protected statusClass(s: string) {
    if (s === "confirmed") return "text-teal-700 dark:text-teal-400";
    if (s === "uncertain") return "font-medium text-amber-700 dark:text-amber-400";
    if (s === "offered") return "text-teal-600";
    if (s === "waitlisted") return "text-sky-700 dark:text-sky-400";
    return "text-stone-500";
  }
  protected calendarText(p: RosterRow) {
    const c = p.calendar;
    if (p.status === "uncertain") return "volunteer deleted the event";
    if (c.status === "drift") return `volunteer changed it to ${c.drift?.observedStart?.slice(11, 16) ?? "?"}`;
    if (c.status === "retrying") return `retrying (attempt ${c.attempts}): ${c.lastError ?? ""}`;
    if (c.status === "failed") return `failed: ${c.lastError ?? ""}`;
    if (!this.isActive(p.status) && c.status === "synced") return "removed from calendar";
    return this.syncLabel(c.status);
  }
  protected groups(r: Roster) {
    const n = (s: string) => r.roster.filter((p) => p.status === s).length;
    return [
      { label: "confirmed", n: n("confirmed") },
      { label: "uncertain ❓", n: n("uncertain") },
      { label: "offered", n: n("offered") },
      { label: "waitlisted", n: n("waitlisted") },
    ];
  }

  private async loadAll() {
    try {
      const me = await this.api.get<Me>("/me");
      this.me.set(me);
      if (me.role !== "coordinator") return;
      await this.loadSeason();
      if (!this.selectedId()) {
        const firstFull = this.season().find((o) => !o.past && o.status === "scheduled" && o.waitlisted > 0);
        if (firstFull) await this.select(firstFull.id);
      }
    } catch {
      /* header shows errors */
    }
  }

  private async loadSeason() {
    this.season.set((await this.api.get<{ occurrences: SeasonRow[] }>("/season")).occurrences);
  }
  private async loadSummary() {
    this.summary.set((await this.api.get<{ byStatus: Record<string, number> }>("/sync/summary")).byStatus);
  }

  private async poll() {
    if (this.me()?.role !== "coordinator") return;
    try {
      if (this.tab() === "season") {
        await this.loadSeason();
        if (this.selectedId()) await this.loadRoster();
      }
      if (this.tab() === "sync") await this.loadSummary();
    } catch {
      /* transient */
    }
  }

  protected async select(id: string) {
    this.selectedId.set(id);
    this.mode.set(null);
    this.actionMessage.set(null);
    await this.loadRoster();
    const s = this.roster()?.shift;
    if (s) this.moveForm = { date: s.localDate, localStart: s.localStart, localEnd: s.localEnd };
  }
  private async loadRoster() {
    const id = this.selectedId();
    if (id) this.roster.set(await this.api.get<Roster>(`/occurrences/${encodeURIComponent(id)}/roster`));
  }

  protected async move() {
    try {
      const r = await this.api.post<{ affected: number; to: string }>(`/occurrences/${encodeURIComponent(this.selectedId()!)}/move`, this.moveForm);
      this.actionMessage.set(`✓ Moved to ${r.to}. ${r.affected} people notified; calendar updates are shown per person below.`);
      this.mode.set(null);
    } catch (e) {
      this.actionMessage.set(errorMessage(e));
    }
    await this.poll();
  }

  protected async cancel() {
    try {
      const r = await this.api.post<{ affected: number }>(`/occurrences/${encodeURIComponent(this.selectedId()!)}/cancel`, { note: this.cancelNote });
      this.actionMessage.set(`✓ Cancelled. ${r.affected} people notified; their calendar events are being removed.`);
      this.mode.set(null);
      this.cancelNote = "";
    } catch (e) {
      this.actionMessage.set(errorMessage(e));
    }
    await this.poll();
  }

  protected async removeSignup(p: RosterRow) {
    if (!confirm(`Remove ${p.name} from this shift? If they held a seat, it's offered to the waitlist.`)) return;
    try {
      await this.api.post(`/signups/${p.signupId}/cancel`);
    } catch (e) {
      this.actionMessage.set(errorMessage(e));
    }
    await this.poll();
  }

  protected async retry(p: RosterRow) {
    await this.api.post(`/links/${p.signupId}/retry`);
    await this.poll();
  }

  protected async runAudit() {
    this.audit.set(await this.api.get<Audit>("/sync/audit"));
  }

  protected async createSeries() {
    try {
      const r = await this.api.post<{ occurrences: number; series: { title: string } }>("/series", this.seriesForm);
      this.actionMessage.set(`✓ Created "${r.series.title}" with ${r.occurrences} upcoming shifts.`);
      await this.loadSeason();
    } catch (e) {
      this.actionMessage.set(errorMessage(e));
    }
  }
}
