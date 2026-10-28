import { Component, OnDestroy, OnInit, inject, signal } from "@angular/core";
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { ApiService, errorMessage } from "./api.service";
import { CurrentUserService } from "./current-user.service";

@Component({
  selector: "hl-root",
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
        <a routerLink="/" class="font-semibold tracking-tight">Harbor Light <span class="font-normal text-stone-500">shifts</span></a>
        <nav class="flex gap-4 text-sm">
          <a routerLink="/volunteer" routerLinkActive="font-semibold text-teal-700 dark:text-teal-400">Volunteer</a>
          <a routerLink="/coordinator" routerLinkActive="font-semibold text-teal-700 dark:text-teal-400">Coordinator</a>
          <a href="/mockups/" class="text-stone-500 hover:text-stone-800 dark:hover:text-stone-200">Mockups ↗</a>
        </nav>
        <label class="ml-auto flex items-center gap-2 text-sm">
          <span class="text-stone-500">Signed in as</span>
          <select
            class="max-w-56 rounded border border-stone-300 bg-transparent px-2 py-1 dark:border-stone-700"
            [value]="user.selectedId() ?? ''"
            (change)="switchUser($any($event.target).value)"
          >
            <optgroup label="Coordinators">
              @for (u of user.users().coordinators; track u.id) {
                <option [value]="u.id" [selected]="u.id === user.selectedId()">{{ u.name }}</option>
              }
            </optgroup>
            <optgroup label="Volunteers">
              @for (u of user.users().volunteers; track u.id) {
                <option [value]="u.id" [selected]="u.id === user.selectedId()">{{ u.id }} · {{ u.name }}</option>
              }
            </optgroup>
          </select>
        </label>
      </div>
      <div class="border-t border-dashed border-stone-200 bg-amber-50/60 dark:border-stone-800 dark:bg-amber-950/20">
        <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-1.5 text-xs text-stone-600 dark:text-stone-400">
          <span title="The demo runs on a simulated clock that starts at the brief's 'now' and advances in real time.">
            Kitchen time: <strong class="text-stone-800 dark:text-stone-200">{{ clock() }}</strong>
          </span>
          <span class="text-stone-400">·</span>
          <span>Demo controls:</span>
          <button class="underline decoration-dotted hover:text-stone-900 dark:hover:text-stone-100" (click)="advance(6)">+6 h</button>
          <button class="underline decoration-dotted hover:text-stone-900 dark:hover:text-stone-100" (click)="advance(24)">+1 day</button>
          <button class="underline decoration-dotted hover:text-stone-900 dark:hover:text-stone-100" (click)="reset()">Reset demo data</button>
          <a class="underline decoration-dotted hover:text-stone-900 dark:hover:text-stone-100" [href]="simPanel" target="_blank" rel="noopener">Tidewater simulator panel ↗</a>
          @if (devMessage()) {
            <span class="text-stone-800 dark:text-stone-200">{{ devMessage() }}</span>
          }
        </div>
      </div>
      @if (user.loadError(); as message) {
        <p class="mx-auto max-w-6xl px-4 py-2 text-sm text-red-700 dark:text-red-400">{{ message }}</p>
      }
    </header>
    <main class="mx-auto max-w-6xl px-4 py-6"><router-outlet /></main>
  `,
})
export class AppComponent implements OnInit, OnDestroy {
  protected user = inject(CurrentUserService);
  private api = inject(ApiService);
  private router = inject(Router);
  protected clock = signal("…");
  protected devMessage = signal<string | null>(null);
  protected simPanel = location.port === "4200" || location.port === "3000" ? "http://localhost:4010/__sim/panel" : "/__sim/panel";
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit() {
    this.user.load();
    this.tick();
    this.timer = setInterval(() => this.tick(), 30_000);
  }
  ngOnDestroy() {
    clearInterval(this.timer);
  }

  protected switchUser(id: string) {
    this.user.select(id);
    const isCoordinator = this.user.users().coordinators.some((c) => c.id === id);
    void this.router.navigateByUrl(isCoordinator ? "/coordinator" : "/volunteer");
  }

  private async tick() {
    try {
      this.clock.set((await this.api.get<{ kitchen: string }>("/clock")).kitchen);
    } catch {
      this.clock.set("unavailable");
    }
  }

  protected async advance(hours: number) {
    try {
      await this.api.post("/dev/advance", { hours });
      await this.tick();
      this.flash(`Advanced ${hours} h. Offers past their hold expire within a few seconds.`);
    } catch (e) {
      this.flash(errorMessage(e));
    }
  }

  protected async reset() {
    if (!confirm("Reset all demo data and the simulator to the seed? This affects everyone using this demo.")) return;
    this.flash("Resetting…");
    try {
      await this.api.post("/dev/reset");
      this.user.load();
      await this.tick();
      this.flash("Reset done. Calendars are re-syncing in the background.");
    } catch (e) {
      this.flash(errorMessage(e));
    }
  }

  private flash(msg: string) {
    this.devMessage.set(msg);
    setTimeout(() => this.devMessage() === msg && this.devMessage.set(null), 6000);
  }
}
