// Shared state for the Socials tabs: networks, connected accounts, today's counts, caps, kill switch.
import { createContext, useContext } from "react";
import type { Account, NetworkInfo } from "../../studio";

export type Net = { networks: NetworkInfo[]; accounts: Account[]; redirects: { loopback: string; relay: string }; today: Record<string, number>; postCaps: Record<string, number>; killSwitch: { posting: boolean; drafts: boolean } };
export type SocialState = Net & { reload: () => void; netName: (id: string) => string; accountLabel: (id: string) => string };
export const SocialCtx = createContext<SocialState | null>(null);
export const useSocial = () => useContext(SocialCtx)!;
