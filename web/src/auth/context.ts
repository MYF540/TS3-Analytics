import { createContext, useContext } from 'react';
import type { AuthUser } from '../api/types';

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

/** Only same-app paths are allowed as redirect targets (no open redirect). */
export function safeRedirect(target: string | null): string {
  return target?.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\')
    ? target
    : '/';
}
