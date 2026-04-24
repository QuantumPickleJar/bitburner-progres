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


/**
 * @typedef {object} ScoreResult
 * @property {number} moneyFillRatio
 * @property {number} maxMoneyFill
 * @property {number} securityRatio
 * @property {number} sizeScore
 * @property {number} normalizedFill
 * @property {number} score
 */
export interface ScoreResult { 
	moneyFillRatio: moneyFill;
	maxMoneyFill: maxMoneyFill;
	securityRatio: securityRatio;
	sizeScore: sizeScore;
	normalizedFill: normalizedFill;
	score: score;
}

export interface MultiLayeredProgressBar { 
	scoredSnapshotTuple: ScoredServerSnapshotTuple;
	styles: Record<string, object>;
}

export interface ScoredServerSnapshotTuple { 
	detailedScore: ScoreResult;
	server: ServerSnapshot;
}