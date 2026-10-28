import { Routes } from "@angular/router";

export const routes: Routes = [
  { path: "", pathMatch: "full", redirectTo: "volunteer" },
  { path: "coordinator", loadComponent: () => import("./pages/coordinator.page").then((m) => m.CoordinatorPage) },
  { path: "volunteer", loadComponent: () => import("./pages/volunteer.page").then((m) => m.VolunteerPage) },
];
