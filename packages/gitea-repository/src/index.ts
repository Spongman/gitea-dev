export { HttpGiteaRepository, DEFAULT_MAX_FILE_SIZE } from './repository.js';
export { DEFAULT_LIMITS } from './http.js';
export { GiteaRefs, validateBranchName } from './refs.js';
export type {
	BranchList,
	GiteaRefsOptions,
	PullRequestInput,
	PullRequestResult,
	RefInfo,
	RemoteComparison,
} from './refs.js';
export {
	AlreadyExistsError,
	CommitOutcomeUnknownError,
	FileTooLargeError,
	RepositoryError,
	StaleBlobError,
	StaleHeadError,
	isRepositoryError,
} from './errors.js';
export type { RepositoryErrorCode } from './errors.js';
export { PersonalAccessTokenAuth } from './auth/pat.js';
export { OAuthPkceAuth, OAuthError } from './auth/oauth.js';
export type { OAuthPkceOptions } from './auth/oauth.js';
export { MemorySecretStore } from './auth/store.js';
export type { SecretStore } from './auth/store.js';
export {
	DEFAULT_BRIDGE_DESCRIPTOR_PATH,
	GiteaSessionBridgeAuth,
	SESSION_BRIDGE_VERSION,
	SessionBridgeUnavailableError,
} from './auth/session-bridge.js';
export type { SessionBridgeDescriptor, SessionBridgeOptions } from './auth/session-bridge.js';
export type {
	AuthProvider,
	CommitResult,
	EntryType,
	GiteaRepository,
	HttpGiteaRepositoryOptions,
	InitializableGiteaRepository,
	LfsInfo,
	ReadFileOptions,
	RepositoryChange,
	RepositoryCommit,
	RepositoryEntry,
	RepositoryFile,
	RepositoryLimits,
	RepositoryState,
	RequestOptions,
} from './types.js';
