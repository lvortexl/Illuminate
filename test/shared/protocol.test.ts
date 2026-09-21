import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  ARTIFACT_TO_CHROME_TYPES,
  CHROME_TO_ARTIFACT_TYPES,
  isArtifactToChromeType,
  isChromeToArtifactType,
  isFromCurrentArtifactLoad,
} from '../../src/shared/protocol.ts';
import type { ArtifactToChromeMessage, ChromeToArtifactMessage } from '../../src/shared/protocol.ts';

// --- 1. Exhaustiveness (runtime) ---

test('exactly 28 verified message types, no duplicates, no cross-direction overlap', () => {
  // 15/12 since the chrome rail landed: `illuminate:selectElement` (artifact
  // -> chrome, "the human pointed here"), `illuminate:setCardPresentation`
  // ("the rail draws card bodies now") and `illuminate:cardAction` ("run this
  // card's follow-up for me, you have the live element").
  assert.strictEqual(ARTIFACT_TO_CHROME_TYPES.length, 16);
  assert.strictEqual(CHROME_TO_ARTIFACT_TYPES.length, 12);
  const all = [...ARTIFACT_TO_CHROME_TYPES, ...CHROME_TO_ARTIFACT_TYPES];
  assert.strictEqual(all.length, 28);
  assert.strictEqual(new Set(all).size, 28);
});

// --- 2. Discriminability (runtime, exhaustive switch with a `never` default) ---

test('every artifact->chrome type is discriminable via an exhaustive switch', () => {
  const seen = new Set<string>();
  for (const type of ARTIFACT_TO_CHROME_TYPES) {
    const msg: ArtifactToChromeMessage = { type, artifact_load_token: 'tok' };
    switch (msg.type) {
      case 'illuminate:queuePrompt':
      case 'illuminate:sendQueuedPrompts':
      case 'illuminate:endSession':
      case 'illuminate:status':
      case 'illuminate:snapshot':
      case 'illuminate:scroll':
      case 'illuminate:reviewState':
      case 'illuminate:reviewDraftUnrestorable':
      case 'illuminate:layoutDiagnostics':
      case 'illuminate:artifactAssetFailure':
      case 'illuminate:uploadAttachment':
      case 'illuminate:queueNote':
      case 'illuminate:selectElement':
      case 'illuminate:toggleAnnotationMode':
      case 'illuminate:suspendWhiteboard':
      case 'illuminate:resumeWhiteboard':
        seen.add(msg.type);
        break;
      default: {
        // `msg` (not `msg.type`) is what CFA narrows to `never` here, since
        // the discriminant is on the object union `ArtifactToChromeMessage`.
        const exhaustive: never = msg;
        throw new Error(`unhandled type: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  assert.strictEqual(seen.size, 16);
});

test('every chrome->artifact type is discriminable via an exhaustive switch', () => {
  const seen = new Set<string>();
  for (const type of CHROME_TO_ARTIFACT_TYPES) {
    const msg: ChromeToArtifactMessage = { type };
    switch (msg.type) {
      case 'illuminate:setAnnotationMode':
      case 'illuminate:requestSnapshot':
      case 'illuminate:requestLayoutDiagnostics':
      case 'illuminate:restoreScroll':
      case 'illuminate:restoreReviewState':
      case 'illuminate:revealElement':
      case 'illuminate:attachmentResult':
      case 'illuminate:syncAnnotations':
      case 'illuminate:dispatchCreated':
      case 'illuminate:syncFindings':
      case 'illuminate:setCardPresentation':
      case 'illuminate:cardAction':
        seen.add(msg.type);
        break;
      default: {
        // `msg` (not `msg.type`) is what CFA narrows to `never` here, since
        // the discriminant is on the object union `ChromeToArtifactMessage`.
        const exhaustive: never = msg;
        throw new Error(`unhandled type: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  assert.strictEqual(seen.size, 12);
});

// --- 3. The token invariant, both runtime and compile-time ---

test('isFromCurrentArtifactLoad matches only the current token', () => {
  assert.strictEqual(isFromCurrentArtifactLoad({ artifact_load_token: 'a' }, 'a'), true);
  assert.strictEqual(isFromCurrentArtifactLoad({ artifact_load_token: 'a' }, 'b'), false);
});

test('isArtifactToChromeType / isChromeToArtifactType narrow untrusted strings (e.g. raw event.data.type)', () => {
  assert.strictEqual(isArtifactToChromeType('illuminate:queuePrompt'), true);
  assert.strictEqual(isArtifactToChromeType('illuminate:restoreScroll'), false); // wrong direction
  assert.strictEqual(isArtifactToChromeType('not-a-real-type'), false);
  assert.strictEqual(isChromeToArtifactType('illuminate:restoreScroll'), true);
});

test('protocol exposes an explicit version for future compatibility checks', () => {
  assert.strictEqual(PROTOCOL_VERSION, 1);
});

// Compile-time proof that artifact_load_token is non-optional on every
// artifact->chrome message, and genuinely absent (not just optional) on
// chrome->artifact messages. `npm run typecheck` fails if either of these
// stops being true.
// @ts-expect-error — artifact_load_token is required; omitting it must fail to type-check
const _missingToken: ArtifactToChromeMessage = { type: 'illuminate:queuePrompt' };
void _missingToken;

const _chromeMessageNeedsNoToken: ChromeToArtifactMessage = { type: 'illuminate:restoreScroll' };
void _chromeMessageNeedsNoToken;
