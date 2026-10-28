// Starter skeleton — replace freely.
// Stand-in for auth: the user picks who they are from a list served by the skeleton server.
import { HttpClient } from "@angular/common/http";
import { Injectable, computed, inject, signal } from "@angular/core";

export interface UserSummary {
  id: string;
  name: string;
}
export interface UserList {
  coordinators: UserSummary[];
  volunteers: UserSummary[];
}

@Injectable({ providedIn: "root" })
export class CurrentUserService {
  private http = inject(HttpClient);
  readonly users = signal<UserList>({ coordinators: [], volunteers: [] });
  readonly loadError = signal<string | null>(null);
  readonly selectedId = signal<string | null>(null);
  readonly current = computed(() => {
    const { coordinators, volunteers } = this.users();
    const id = this.selectedId();
    const coordinator = coordinators.find((u) => u.id === id);
    if (coordinator) return { ...coordinator, role: "coordinator" as const };
    const volunteer = volunteers.find((u) => u.id === id);
    return volunteer ? { ...volunteer, role: "volunteer" as const } : null;
  });

  load() {
    this.http.get<UserList>("/api/users").subscribe({
      next: (list) => {
        this.users.set(list);
        this.loadError.set(null);
        if (!this.selectedId()) this.selectedId.set(list.volunteers[0]?.id ?? list.coordinators[0]?.id ?? null);
      },
      error: () => this.loadError.set("Couldn't load users. Is the skeleton server running, and has POST /seed been called?"),
    });
  }
}
