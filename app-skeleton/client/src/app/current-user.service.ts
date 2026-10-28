// Stand-in for auth: the user picks who they are from a list served by the server.
import { HttpClient } from "@angular/common/http";
import { Injectable, computed, inject, signal } from "@angular/core";

export interface UserSummary {
  id: string;
  name: string;
  tz?: string;
}
export interface UserList {
  coordinators: UserSummary[];
  volunteers: UserSummary[];
}

const STORAGE_KEY = "hl.user";

function stored(): string | null {
  const fromUrl = new URLSearchParams(location.search).get("as"); // deep link: /coordinator?as=C01
  if (fromUrl) return fromUrl;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

@Injectable({ providedIn: "root" })
export class CurrentUserService {
  private http = inject(HttpClient);
  readonly users = signal<UserList>({ coordinators: [], volunteers: [] });
  readonly loadError = signal<string | null>(null);
  readonly selectedId = signal<string | null>(stored());
  readonly current = computed(() => {
    const { coordinators, volunteers } = this.users();
    const id = this.selectedId();
    const coordinator = coordinators.find((u) => u.id === id);
    if (coordinator) return { ...coordinator, role: "coordinator" as const };
    const volunteer = volunteers.find((u) => u.id === id);
    return volunteer ? { ...volunteer, role: "volunteer" as const } : null;
  });

  select(id: string) {
    this.selectedId.set(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* private mode: selection just won't persist */
    }
  }

  load() {
    this.http.get<UserList>("/api/users").subscribe({
      next: (list) => {
        this.users.set(list);
        this.loadError.set(null);
        const id = this.selectedId();
        const known = [...list.coordinators, ...list.volunteers].some((u) => u.id === id);
        if (!known) this.select(list.volunteers.find((v) => v.id === "V04")?.id ?? list.volunteers[0]?.id ?? list.coordinators[0]?.id);
      },
      error: () => this.loadError.set("Couldn't load users. Is the server running? The seed loads automatically on first start."),
    });
  }
}
