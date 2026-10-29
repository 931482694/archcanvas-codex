// Codex UserPromptSubmit hook: tells Codex about tasks newly handed over on
// the canvas (see runtime/hooks.mjs).
import { onPrompt, runHook } from '../runtime/hooks.mjs'

runHook(onPrompt)
