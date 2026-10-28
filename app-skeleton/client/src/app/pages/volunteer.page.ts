import { Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { ApiService, errorMessage, type Me, type NotificationItem, type VolunteerShift } from "../api.service";
import { CurrentUserService } from "../current-user.service";

type Filter = "mine" | "all";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "You're confirmed",
  waitlisted: "On the waitlist",
  offered: "Spot held for you",
  uncertain: "Removed from your calendar",
  cancelled: "You cancelled",
  cancelled_by_org: "Cancelled by the kitchen",
};

const CALENDAR_LABEL: Record<string, string> = {
  synced: "on your calendar",
  pending: "adding to your calendar…",
  retrying: "calendar update delayed, retrying",
  failed: "couldn't update your calendar",
  drift: "your calendar shows a different time",
};

@Component({
  selector: "hl-volunteer-page",
  imports: [RouterLink],
  template: `
    @if (me(); as me) {
      @if (me.role !== "volunteer") {
        <p class="text-stone-600">You're signed in as a coordinator. Pick a volunteer in the switcher, or go to the <a class="underline" routerLink="/coordinator">coordinator view</a>.</p>
      } @else {
        <section class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">Hi, {{ me.name.split(" ")[0] }}</h1>
            <p class="mt-1 max-w-2xl text-sm text-stone-600 dark:text-stone-400">
              Shift times are in <strong>kitchen time (Central)</strong>, the time you should be at the door.
              @if (me.tz !== me.kitchenTz) {
                Your own time ({{ me.zoneLabel }}) is shown next to each one.
              }
              @if (me.tzSource === "defaulted") {
                <span class="text-amber-700 dark:text-amber-400">We don't know your time zone, so only kitchen time is shown.</span>
              }
            </p>
          </div>
          <div class="rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm dark:border-stone-800 dark:bg-stone-900">
            <div class="font-medium">Tidewater Calendar</div>
            @if (me.calendarConnected) {
              <p class="text-stone-600 dark:text-stone-400">Connected. Confirmed shifts are added automatically.</p>
              <button class="mt-1 text-xs underline" (click)="setCalendar(false)">Disconnect (removes our events)</button>
            } @else {
              <p class="text-stone-600 dark:text-stone-400">Not connected.</p>
              <button class="mt-1 rounded bg-teal-700 px-3 py-1 text-xs font-medium text-white hover:bg-teal-800" (click)="setCalendar(true)">Connect calendar</button>
            }
          </div>
        </section>

        @if (needsAction().length) {
          <section class="mt-6 space-y-3">
            <h2 class="text-sm font-semibold uppercase tracking-wide text-stone-500">Needs your answer</h2>
            @for (s of needsAction(); track s.id) {
              <div class="rounded-lg border-l-4 bg-white p-4 shadow-sm dark:bg-stone-900" [class]="s.mine!.status === 'offered' ? 'border-teal-600' : 'border-amber-500'">
                <div class="font-medium">{{ s.title }} · {{ s.kitchenTime }}</div>
                @if (s.yourTime) {
                  <div class="text-sm text-stone-500">{{ s.yourTime }} your time</div>
                }
                @switch (true) {
                  @case (s.mine!.status === "offered") {
                    <p class="mt-2 text-sm">A spot opened and it's held for you until <strong>{{ s.mine!.offerExpiresLabel }}</strong>. After that it goes to the next person.</p>
                    <div class="mt-3 flex gap-2">
                      <button class="btn-primary" (click)="act(s, 'accept')">Take the spot</button>
                      <button class="btn-secondary" (click)="act(s, 'decline')">Pass</button>
                    </div>
                  }
                  @case (s.mine!.status === "uncertain") {
                    <p class="mt-2 text-sm">You deleted this shift from your calendar. That doesn't cancel it. The kitchen still has you down. Are you coming?</p>
                    <div class="mt-3 flex gap-2">
                      <button class="btn-primary" (click)="act(s, 'keep')">I'm still coming (re-add it)</button>
                      <button class="btn-secondary" (click)="act(s, 'cancel')">Cancel my spot</button>
                    </div>
                  }
                  @default {
                    <p class="mt-2 text-sm">This shift <strong>moved</strong> from {{ s.movedFrom }}. Your calendar is being updated.</p>
                    <div class="mt-3"><button class="btn-primary" (click)="act(s, 'ack-move')">Got it</button></div>
                  }
                }
                @if (rowMessage()[s.id]; as m) {
                  <p class="mt-2 text-sm text-red-700 dark:text-red-400">{{ m }}</p>
                }
              </div>
            }
          </section>
        }

        <section class="mt-8">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="text-lg font-semibold">Shifts</h2>
            <div class="inline-flex rounded-md border border-stone-300 text-sm dark:border-stone-700">
              <button class="px-3 py-1" [class.bg-stone-200]="filter() === 'all'" [class.dark:bg-stone-800]="filter() === 'all'" (click)="filter.set('all')">All upcoming</button>
              <button class="px-3 py-1" [class.bg-stone-200]="filter() === 'mine'" [class.dark:bg-stone-800]="filter() === 'mine'" (click)="filter.set('mine')">Mine</button>
            </div>
          </div>
          @if (loading()) {
            <p class="mt-4 text-sm text-stone-500">Loading shifts…</p>
          }
          <ul class="mt-3 divide-y divide-stone-200 overflow-hidden rounded-lg border border-stone-200 bg-white dark:divide-stone-800 dark:border-stone-800 dark:bg-stone-900">
            @for (s of visible(); track s.id) {
              <li class="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3" [class.opacity-60]="s.status === 'cancelled'">
                <div class="min-w-64 flex-1">
                  <div class="font-medium">{{ s.title }}</div>
                  <div class="text-sm">
                    <span class="font-medium">{{ s.kitchenTime }}</span>
                    @if (s.yourTime) {
                      <span class="text-stone-500"> · {{ s.yourTime.split(" · ")[1] }} your time</span>
                    }
                  </div>
                  @if (s.movedFrom) {
                    <div class="text-xs text-amber-700 dark:text-amber-400">Moved, was {{ s.movedFrom }}</div>
                  }
                  @if (s.status === "cancelled") {
                    <div class="text-xs text-stone-500">Cancelled{{ s.note ? " · " + s.note : "" }}</div>
                  }
                </div>
                <div class="w-40 text-sm text-stone-600 dark:text-stone-400">
                  @if (s.status === "scheduled") {
                    @if (s.spotsLeft > 0) {
                      {{ s.spotsLeft }} of {{ s.capacity }} spots open
                    } @else {
                      Full · {{ s.waitlisted }} waiting
                    }
                  }
                </div>
                <div class="w-64 text-sm">
                  @if (s.mine; as m) {
                    <div [class]="statusClass(m.status)">
                      {{ label(m.status) }}
                      @if (m.status === "waitlisted") {
                        (#{{ m.waitlistPosition }})
                      }
                    </div>
                    @if (m.calendar && m.status === "confirmed") {
                      <div class="text-xs text-stone-500" [title]="m.calendar.lastError ?? ''">{{ calendarLabel(m.calendar.status) }}</div>
                    }
                  }
                </div>
                <div class="w-36 text-right">
                  @if (s.status === "scheduled") {
                    @if (!s.mine || !isActive(s.mine.status)) {
                      <button class="btn-primary w-full" [disabled]="busy() === s.id" (click)="signUp(s)">{{ s.spotsLeft > 0 ? "Sign up" : "Join waitlist" }}</button>
                    } @else if (s.mine.status === "confirmed" || s.mine.status === "waitlisted") {
                      <button class="btn-secondary w-full" [disabled]="busy() === s.id" (click)="act(s, 'cancel')">{{ s.mine.status === "waitlisted" ? "Leave waitlist" : "Cancel" }}</button>
                    }
                  }
                </div>
                @if (rowMessage()[s.id]; as m) {
                  <p class="basis-full text-sm" [class]="m.startsWith('✓') ? 'text-teal-700 dark:text-teal-400' : 'text-red-700 dark:text-red-400'">{{ m }}</p>
                }
              </li>
            } @empty {
              @if (!loading()) {
                <li class="px-4 py-6 text-sm text-stone-500">{{ filter() === "mine" ? "You haven't signed up for anything upcoming." : "No upcoming shifts." }}</li>
              }
            }
          </ul>
        </section>

        <section class="mt-8">
          <h2 class="text-lg font-semibold">Messages</h2>
          <p class="text-xs text-stone-500">In-app only in this prototype. Email/SMS delivery is deferred (see README).</p>
          <ul class="mt-2 space-y-2">
            @for (n of notifications(); track n.id) {
              <li class="rounded border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900" [class.font-medium]="!n.readAt">{{ n.message }}</li>
            } @empty {
              <li class="text-sm text-stone-500">No messages.</li>
            }
          </ul>
        </section>
      }
    }
  `,
})
export class VolunteerPage {
  private api = inject(ApiService);
  private user = inject(CurrentUserService);
  protected me = signal<Me | null>(null);
  protected shifts = signal<VolunteerShift[]>([]);
  protected notifications = signal<NotificationItem[]>([]);
  protected filter = signal<Filter>("all");
  protected loading = signal(true);
  protected busy = signal<string | null>(null);
  protected rowMessage = signal<Record<string, string>>({});

  protected visible = computed(() => (this.filter() === "mine" ? this.shifts().filter((s) => s.mine) : this.shifts()));
  protected needsAction = computed(() => this.shifts().filter((s) => s.mine && (s.mine.status === "offered" || s.mine.status === "uncertain" || s.mine.moveUnacknowledged)));

  constructor() {
    effect(() => {
      if (this.user.selectedId() && this.user.users().volunteers.length) void this.load(true);
    });
    // Polls so offers and calendar status show up without a reload. Not real-time; every 5s.
    const t = setInterval(() => void this.load(false), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  protected label = (s: string) => STATUS_LABEL[s] ?? s;
  protected calendarLabel = (s: string) => CALENDAR_LABEL[s] ?? s;
  protected isActive = (s: string) => ["confirmed", "waitlisted", "offered", "uncertain"].includes(s);
  protected statusClass(s: string) {
    if (s === "confirmed") return "font-medium text-teal-700 dark:text-teal-400";
    if (s === "offered" || s === "uncertain") return "font-medium text-amber-700 dark:text-amber-400";
    return "text-stone-600 dark:text-stone-400";
  }

  private async load(full: boolean) {
    try {
      if (full) {
        this.loading.set(true);
        this.rowMessage.set({});
      }
      const me = await this.api.get<Me>("/me");
      this.me.set(me);
      if (me.role !== "volunteer") return;
      const [shifts, notes] = await Promise.all([this.api.get<{ shifts: VolunteerShift[] }>("/shifts"), this.api.get<{ notifications: NotificationItem[] }>("/notifications")]);
      this.shifts.set(shifts.shifts);
      this.notifications.set(notes.notifications);
    } catch {
      /* keep last good data; the header shows load errors */
    } finally {
      this.loading.set(false);
    }
  }

  private setMsg(id: string, msg: string) {
    this.rowMessage.update((m) => ({ ...m, [id]: msg }));
  }

  protected async signUp(s: VolunteerShift) {
    this.busy.set(s.id);
    try {
      const r = await this.api.post<{ status: string; waitlistPosition: number | null }>(`/occurrences/${encodeURIComponent(s.id)}/signup`);
      // The server's answer is authoritative: if the last spot went to someone else a moment ago, we say so.
      this.setMsg(s.id, r.status === "confirmed" ? "✓ You got a spot." : `✓ The shift filled up, so you're #${r.waitlistPosition} on the waitlist. We'll hold a spot for you if one opens.`);
    } catch (e) {
      this.setMsg(s.id, errorMessage(e));
    } finally {
      this.busy.set(null);
      await this.load(false);
    }
  }

  protected async act(s: VolunteerShift, action: "accept" | "decline" | "keep" | "cancel" | "ack-move") {
    if (action === "cancel" && !confirm(`Cancel ${s.title} on ${s.kitchenTime}? Your spot goes to the next person.`)) return;
    this.busy.set(s.id);
    try {
      await this.api.post(`/signups/${s.mine!.signupId}/${action}`);
      if (action === "accept") this.setMsg(s.id, "✓ The spot is yours.");
      if (action === "cancel") this.setMsg(s.id, "✓ Cancelled. Thanks for letting us know.");
    } catch (e) {
      this.setMsg(s.id, errorMessage(e));
    } finally {
      this.busy.set(null);
      await this.load(false);
    }
  }

  protected async setCalendar(connect: boolean) {
    await this.api.post(`/calendar/${connect ? "connect" : "disconnect"}`);
    await this.load(false);
  }
}

