// Starter skeleton — replace freely.
import { Component, OnInit, inject } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { CurrentUserService } from "./current-user.service";

@Component({
  selector: "hl-root",
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="border-b border-stone-200 dark:border-stone-800">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3">
        <span class="font-semibold">Harbor Light <span class="font-normal text-stone-500">(starter)</span></span>
        <nav class="flex gap-3 text-sm">
          <a routerLink="/volunteer" routerLinkActive="underline">Volunteer</a>
          <a routerLink="/coordinator" routerLinkActive="underline">Coordinator</a>
        </nav>
        <label class="ml-auto flex items-center gap-2 text-sm">
          <span class="text-stone-500">Signed in as</span>
          <select
            class="rounded border border-stone-300 bg-transparent px-2 py-1 dark:border-stone-700"
            [value]="user.selectedId() ?? ''"
            (change)="user.selectedId.set($any($event.target).value)"
          >
            <optgroup label="Coordinators">
              @for (u of user.users().coordinators; track u.id) {
                <option [value]="u.id">{{ u.name }}</option>
              }
            </optgroup>
            <optgroup label="Volunteers">
              @for (u of user.users().volunteers; track u.id) {
                <option [value]="u.id">{{ u.id }} · {{ u.name }}</option>
              }
            </optgroup>
          </select>
        </label>
      </div>
      @if (user.loadError(); as message) {
        <p class="mx-auto max-w-5xl px-4 pb-3 text-sm text-red-700 dark:text-red-400">{{ message }}</p>
      }
    </header>
    <main class="mx-auto max-w-5xl px-4 py-6"><router-outlet /></main>
  `,
})
export class AppComponent implements OnInit {
  protected user = inject(CurrentUserService);
  ngOnInit() {
    this.user.load();
  }
}
