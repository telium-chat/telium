import { createContext, useContext } from 'react';

export const ModalContext = createContext(null);

export function useModal() {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal called outside a ModalProvider');
  return ctx;
}
