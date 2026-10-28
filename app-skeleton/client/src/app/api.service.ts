// Typed access to the server API. The selected user travels as X-User-Id (stand-in for auth).
import { HttpClient, HttpErrorResponse, type HttpInterceptorFn } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { CurrentUserService } from "./current-user.service";

export const userHeaderInterceptor: HttpInterceptorFn = (req, next) => {
  const id = inject(CurrentUserService).selectedId();
  return next(id ? req.clone({ setHeaders: { "x-user-id": id } }) : req);
};

export interface ShiftView {
  id: string;
  seriesId: string;
  title: string;
  status: "scheduled" | "cancelled";
  start: string;
  end: string;
  tz: string;
  kitchenTime: string;
  yourTime: string | null;
  localDate: string;
  localStart: string;
  localEnd: string;
  movedFrom: string | null;
  note: string | null;
  capacity: number;
}

export interface VolunteerShift extends ShiftView {
  spotsLeft: number;
  waitlisted: number;
  mine: {
    signupId: string;
    status: string;
    cancelReason: string | null;
    offerExpiresAt: string | null;
    offerExpiresLabel: string | null;
    waitlistPosition: number | null;
    moveUnacknowledged: boolean;
    calendar: { status: string; lastError: string | null } | null;
  } | null;
}

export interface SeasonRow extends ShiftView {
  past: boolean;
  confirmed: number;
  waitlisted: number;
  offered: number;
  uncertain: number;
  sync: Record<string, number>;
}

export interface RosterRow {
  signupId: string;
  volunteerId: string;
  name: string;
  tz: string;
  tzSource: string;
  localTime: string | null;
  status: string;
  cancelReason: string | null;
  waitlistPosition: number | null;
  offerExpiresAt: string | null;
  offerExpiresLabel: string | null;
  uncertainSince: string | null;
  chase: boolean;
  moveAcknowledged: boolean | null;
  calendar: { status: string; attempts?: number; lastError?: string | null; drift?: { kind: string; observedStart: string | null } | null; nextAttemptAt?: string };
  source: string;
}

export interface Me {
  role: "volunteer" | "coordinator";
  id: string;
  name: string;
  tz: string;
  kitchenTz: string;
  tzSource?: string;
  calendarConnected?: boolean;
  zoneLabel?: string;
}

export interface NotificationItem {
  id: string;
  kind: string;
  message: string;
  occurrenceId: string | null;
  signupId: string | null;
  createdAt: string;
  readAt: string | null;
}

export function errorMessage(e: unknown): string {
  if (e instanceof HttpErrorResponse) return e.error?.message ?? `Request failed (${e.status}).`;
  return "Something went wrong.";
}

@Injectable({ providedIn: "root" })
export class ApiService {
  private http = inject(HttpClient);
  get<T>(path: string) {
    return firstValueFrom(this.http.get<T>(`/api${path}`));
  }
  post<T>(path: string, body: unknown = {}) {
    return firstValueFrom(this.http.post<T>(`/api${path}`, body));
  }
}
