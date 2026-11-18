'use client';
import { createContext, useContext } from 'react';
const Enabled = createContext(false);
export const TopologyCapability = Enabled.Provider;
export const useEntityTopology = () => useContext(Enabled);
