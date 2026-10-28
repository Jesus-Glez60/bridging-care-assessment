// Starter skeleton — replace freely.
import { Component, inject } from "@angular/core";
import { CurrentUserService } from "../current-user.service";

@Component({
  selector: "hl-coordinator-page",
  template: `
    <h1 class="text-xl font-semibold">Coordinator</h1>
    <p class="mt-1 text-stone-500">Signed in as {{ user.current()?.name ?? "nobody yet" }}. Nothing is built here yet.</p>
  `,
})
export class CoordinatorPage {
  protected user = inject(CurrentUserService);
}
