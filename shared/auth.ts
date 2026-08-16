export type WorkspaceRole = "viewer" | "operator" | "administrator";

export interface SessionUser {
  readonly id: string;
  readonly displayName: string;
  readonly role: WorkspaceRole;
}

export interface SessionResponse {
  readonly apiVersion: 1;
  readonly authenticated: true;
  readonly user: SessionUser;
  readonly expiresAt: string;
}

export type AuthenticationAuditAction =
  | "identity_validated"
  | "identity_rejected"
  | "logout"
  | "authorization_denied";

export interface AuthenticationAuditEvent {
  readonly id: number;
  readonly createdAt: string;
  readonly actorId: string | null;
  readonly displayName: string | null;
  readonly action: AuthenticationAuditAction;
  readonly outcome: "succeeded" | "denied" | "failed";
  readonly reasonCode: string;
  readonly metadata: Readonly<Record<string, string>> | null;
}

export interface AuthenticationAuditResponse {
  readonly apiVersion: 1;
  readonly events: readonly AuthenticationAuditEvent[];
}
