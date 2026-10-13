/**
 * The one config file: model ids, role constants and rule settings. Everything that might be tuned lives here,
 * so a reader can see every knob in one place.
 */

export interface ModelConfig {
  /** The hand-written Messages API loop. Iterate here. */
  messagesLoop: string;
  /** The Agent SDK build. */
  agentSdk: string;
  /** The Managed Agents deployment. */
  managedAgents: string;
  /** Only for the final recorded comparison runs. */
  comparison: string;
  /** Bulk checks, where a small model is enough. */
  bulk: string;
}

export interface RoleConfig {
  /** The only person who decides bookings and the only person Ghillie ever messages. */
  organiser: string;
  /** Chief Stewards in order of preference. Only these count as a lead for the lost-lead rule. */
  chiefStewards: string[];
  /** Partner club nominees: can be pencilled as lead, but are not a lead for the lost-lead rule. */
  partnerNominees: string[];
  /** Who may be recorded as the source of an event change, besides the organiser. Provenance only: changes need her approval. */
  eventAuthorities: string[];
}

/**
 * How the organiser is recognised in sources: by a stable sender id on her own trusted channel, never by a display
 * name, an email address or a name in the text. Anything else claiming to be her is an ordinary member's statement.
 */
export interface TrustConfig {
  organiserChatUserId: string;
  /** Her direct-message channel with Ghillie: the only channel where her word is taken as hers. */
  organiserChannel: string;
  /** Chat channels whose names may appear as a source label. Anything else is labelled plain "chat". */
  knownChannels: string[];
}

export interface RuleConfig {
  stewardsPerArena: number;
  /** Over-used from this many calendar weeks running. Two is fine; a week off resets the run. */
  overUsedFrom: number;
  /** Exceptions about staffing only count for events this many weeks away or fewer. */
  lookaheadWeeks: number;
  maxWritesPerRun: number;
  nextStepMaxWords: number;
  maxBullets: number;
  /** Each run starts this long before the previous run's window end. Overlap is safe: writes are idempotent. */
  windowOverlapMinutes: number;
  /** With no previous run, look back this far. */
  firstRunLookbackDays: number;
}

export interface ScheduleConfig {
  timeZone: string;
  /** Local times of the twice-a-weekday run. */
  ticks: string[];
  /** Local time the watchdog checks that runs happened. */
  watchdogAt: string;
  /** A slot counts as missed when no run was logged within this many minutes of it. */
  graceMinutes: number;
}

export interface GhillieConfig {
  models: ModelConfig;
  roles: RoleConfig;
  trust: TrustConfig;
  rules: RuleConfig;
  schedule: ScheduleConfig;
  /** Deny by default: a tool not on this list is never registered. */
  enabledTools: string[];
  planLink: string;
}

export const config: GhillieConfig = {
  models: {
    messagesLoop: 'claude-sonnet-5-5',
    agentSdk: 'claude-sonnet-5-5',
    managedAgents: 'claude-sonnet-5-5',
    comparison: 'claude-opus-5-5',
    bulk: 'claude-haiku-5-5',
  },
  roles: {
    organiser: 'Isla',
    chiefStewards: ['Morven', 'Hamish', 'Eilidh'],
    partnerNominees: ['Torquil'],
    eventAuthorities: ['Isla', 'Circuit secretary'],
  },
  trust: { organiserChatUserId: 'u_isla', organiserChannel: 'dm-isla-ghillie', knownChannels: ['committee', 'stewards'] },
  rules: {
    stewardsPerArena: 2,
    overUsedFrom: 3,
    lookaheadWeeks: 6,
    maxWritesPerRun: 60,
    nextStepMaxWords: 15,
    maxBullets: 10,
    windowOverlapMinutes: 60,
    firstRunLookbackDays: 3,
  },
  schedule: { timeZone: 'Europe/London', ticks: ['13:00', '18:00'], watchdogAt: '20:00', graceMinutes: 90 },
  enabledTools: [
    'read_rota',
    'set_availability',
    'set_decision',
    'update_person',
    'update_event',
    'propose_recruit',
    'log_run',
    'message_organiser',
  ],
  planLink: 'https://rota.example.scot/plan',
};
