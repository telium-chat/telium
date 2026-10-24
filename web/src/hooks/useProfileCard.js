import { createContext, useContext } from 'react';

export const ProfileCardContext = createContext(null);

export const OpenProfileContext = createContext(null);

export function useProfileCard() {
  const ctx = useContext(ProfileCardContext);
  if (!ctx) throw new Error('useProfileCard called outside a ProfileCardProvider');
  return ctx;
}

export function useOpenProfile() {
  return useContext(OpenProfileContext);
}
