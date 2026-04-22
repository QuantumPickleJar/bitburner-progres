export interface ServerStoreMeta {
	root: string;
	maxDepth: number | "all";
}

export interface ServerSnapshot {
	hostname: string;
	hasRoot: boolean;
	backdoor?: boolean;
	sshOpen?: boolean;
	ftpOpen?: boolean;
	sqlOpen?: boolean;
	httpOpen?: boolean;
	smtpOpen?: boolean;
    portsRequired: number;
    openPorts: number;
	cores: number;
	maxRam: number;
	usedRam: number;
	maxMoney: number;
	money: number;
	minSecurity: number;
	security: number;
	updatedAt: number;
}

export interface ServerStore {
	servers: ServerSnapshot[];
	updatedAt: number;
	meta: ServerStoreMeta;
}

export interface NormalizedServerSnapshot { 
	snapshot: ServerSnapshot;
	moneyNow: number;
	maxMoney: number;
	moneyFillRatio: number;
	security: number;
	minSecurity: number;
	securityRatio: number;
	normalizedScore: number;
}