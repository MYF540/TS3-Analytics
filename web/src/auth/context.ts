import { createContext, useContext } from 'react';
import type { AdminRole, AuthUser } from '../api/types';

export type AuthState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: AuthUser };

export interface AuthContextValue {
  state: AuthState;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside of AuthProvider');
  return value;
}

const ROLE_RANK: Record<AdminRole, number> = { viewer: 1, moderator: 2, admin: 3 };

export function hasRole(user: AuthUser | undefined, role: AdminRole): boolean {
  return user !== undefined && ROLE_RANK[user.role] >= ROLE_RANK[role];
}

/** The signed-in user, if any. */
export function useCurrentUser(): AuthUser | undefined {
  const { state } = useAuth();
  return state.status === 'authenticated' ? state.user : undefined;
}

/** Only same-app paths are allowed as redirect targets (no open redirect). */
export function safeRedirect(target: string | null): string {
  return target?.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\')
    ? target
    : '/';
}
