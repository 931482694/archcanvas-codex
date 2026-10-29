// Codex PostToolUse hook for apply_patch: records the edit in the
// architecture graph's change history (see runtime/hooks.mjs).
import { onPost, runHook } from '../runtime/hooks.mjs'

runHook(onPost)
