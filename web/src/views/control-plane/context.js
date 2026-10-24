import { createContext, useContext } from 'react';

export const ControlPlaneContext = createContext(null);

export const useControlPlane = () => useContext(ControlPlaneContext);
