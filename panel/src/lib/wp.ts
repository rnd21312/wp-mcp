/** Shapes of what the bridge returns for the actions the panel pages use. Fields are optional: older bridges send less. */

export interface HealthProblem {
  status?: string;
  test?: string;
  detail?: string;
}
export interface HealthData {
  versions?: { wordpress?: string; php?: string; mysql?: string };
  problems: HealthProblem[];
  runtime?: { https?: boolean; memory_limit?: string; disk_free?: string; wp_debug?: boolean };
  [extra: string]: unknown;
}
export interface PendingUpdate {
  slug?: string;
  plugin?: string;
  theme?: string;
  name?: string;
  from?: string;
  to?: string;
  version?: string;
}
export interface UpdatesData {
  current_wordpress?: string;
  core?: PendingUpdate[];
  plugins?: PendingUpdate[];
  themes?: PendingUpdate[];
}
export interface BackupEntry {
  id: string;
  label?: string;
  created?: string;
  size?: string | number;
  tables?: number;
}
export interface BackupList {
  backups?: BackupEntry[];
}
export interface DbTable {
  table: string;
  rows?: number;
  size?: string | number;
  overhead?: string | number;
}
export interface DbInfo {
  tables?: DbTable[];
  total_size?: string;
  autoload?: { size?: string };
  cleanable: Record<string, number>;
  [extra: string]: unknown;
}
export interface LogEntry {
  count?: number;
  line?: string;
  message?: string;
  level?: string;
  last?: string;
  text?: string;
}
export interface LogsData {
  entries?: LogEntry[];
  note?: string;
  [extra: string]: unknown;
}
export interface PluginRow {
  plugin: string;
  name?: string;
  version?: string;
  active?: boolean;
  status?: string;
  update?: string | boolean | null;
  update_available?: string | boolean | null;
  description?: string;
  slug?: string;
  rating?: number;
  active_installs?: number;
  [extra: string]: unknown;
}
export interface PluginList {
  plugins?: PluginRow[];
  results?: PluginRow[];
}
export interface CacheFlush {
  flushed: string[];
}
export interface ThemeFile {
  path: string;
  bytes?: number;
  size?: number;
}
export interface ThemeFiles {
  files?: ThemeFile[];
  theme?: string;
}
export interface RestRoute {
  route: string;
  methods: string[];
}
export interface RestRoutes {
  routes?: RestRoute[];
  namespaces?: string[];
}
export interface MenuRef {
  id?: number;
  term_id?: number;
  name?: string;
  slug?: string;
  count?: number;
  items?: number;
  locations?: string[];
}
export interface MenusData {
  menus?: MenuRef[];
  locations?: Record<string, unknown>;
}
export interface TemplateRow {
  slug: string;
  area?: string;
  title?: string;
  kind: string;
  source?: string;
  custom?: boolean;
  [extra: string]: unknown;
}
export interface TemplatesData {
  templates?: TemplateRow[];
  [extra: string]: unknown;
}
export interface ContentRow {
  id: number;
  title: string;
  status: string;
  url: string;
  type?: string;
  slug?: string;
  modified?: string;
  [extra: string]: unknown;
}
export interface ContentList {
  items?: ContentRow[];
  total?: number;
  pages?: number;
}
export interface TextData {
  content?: string;
  [extra: string]: unknown;
}
/** Anything else a call returns: a plain JSON object whose fields are read with care. */
export type Obj = Record<string, unknown>;
export interface TransferFailure {
  slug?: string;
  old_id?: number | string;
  error?: string;
}
export interface TransferKindReport {
  created: number;
  skipped: number;
  failed: TransferFailure[];
}
export interface TransferResult {
  report?: Record<string, TransferKindReport>;
  id_map?: Obj;
  next?: { page: number };
  would_copy?: Record<string, number>;
}
export interface TransferTotal {
  created: number;
  skipped: number;
  failed: TransferFailure[];
}
export interface TokensData {
  site_tokens?: {
    colors?: Record<string, string>;
    fonts?: Record<string, string>;
    radius?: string;
    content_width?: string;
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}
export interface CssData {
  sections?: Record<string, string>;
  theme_additional_css?: string;
}
export interface MenuItem {
  id: number | string;
  title?: string;
  url?: string;
  children?: MenuItem[];
}
export interface MenuTree {
  items?: MenuItem[];
}
export interface AuditIssue {
  severity?: string;
  level?: string;
  message?: string;
  issue?: string;
  fix?: string;
  [extra: string]: unknown;
}
export interface RedirectRow {
  from: string;
  to?: string;
  code?: number | string;
  regex?: boolean;
  [extra: string]: unknown;
}
