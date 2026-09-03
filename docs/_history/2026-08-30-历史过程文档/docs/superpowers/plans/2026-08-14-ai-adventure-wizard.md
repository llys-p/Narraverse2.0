# Online AI Adventure Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded two-page adventure creator with a three-step material → AI proposals → confirmation flow that generates an editable adventure title and preserves a locked custom profession.

**Architecture:** Keep the existing static SPA and global-script style. Add creation-session-only state and pure proposal parsing helpers in `app/app.js`, reuse the existing material library, render the new three steps into existing modal anchors, and map only the selected proposal into the existing `Adventure` object.

**Tech Stack:** Plain HTML, CSS, browser JavaScript, existing OpenAI-compatible `callLLM`, Node `vm` headless regression scripts.

**Spec:** `docs/superpowers/specs/2026-08-14-ai-adventure-wizard-design.md`

## Global Constraints

- No build step and no new runtime dependency.
- Generate exactly three requested proposals, but display any valid subset if one response object is malformed.
- A non-empty custom profession is the highest-priority source and must survive generation, navigation, selection, and creation.
- Unselected proposals stay in the creation session and are never persisted into an adventure.
- Existing material search, category, preview, NSFW, and card/list views remain available.
- Starting the adventure uses the selected proposal's opening hook before character-card greeting selection.
- Every source change requires a reverse-chronological entry in `项目协作日志.md` with exact `YYYY-MM-DD HH:MM` time.
- Structural changes must update `代码指南.md`.
- This workspace is not a Git repository; do not add commit steps or attempt commits.

## File Map

- Modify `app/app.js`: creation session state, pure JSON parser, three-step navigation, AI generation, proposal selection, confirmation binding, profession lock, adventure title/opening mapping.
- Modify `app/index.html`: replace the two-step modal structure with three step containers and add preference/status/proposal anchors.
- Modify `app/redesign.css`: selected-material tray, proposal cards, loading/error states, responsive confirmation cards.
- Modify `.workbuddy/tmp/test_adventure_wizard.js`: update old two-step expectations and add parser, state retention, profession lock, title, opening-hook regressions.
- Modify `代码指南.md`: document new temporary state, functions, data flow, and the custom-profession root cause.
- Modify `项目协作日志.md`: add final implementation and verification record.

---

### Task 1: Creation Session State and Proposal Parser

**Files:**
- Modify: `app/app.js:28`
- Modify: `app/app.js:5199`
- Test: `.workbuddy/tmp/test_adventure_wizard.js:53`

**Interfaces:**
- Produces: `normalizeStoryProposal(raw, index, lockedProfession): StoryProposal`
- Produces: `parseStoryProposals(rawText, lockedProfession): StoryProposal[]`
- Produces: `resetAdventureCreationSession(): void`
- Produces: `getLockedProfession(): string`
- Consumes: existing `escapeHtml`, `customProfession`, `state.selectedProfession`, and DOM element `customProfessionInput`.

- [ ] **Step 1: Expose the future helpers in the headless harness**

Extend `globalThis.__api` in `.workbuddy/tmp/test_adventure_wizard.js` with:

```js
parseStoryProposals,
normalizeStoryProposal,
resetAdventureCreationSession,
getLockedProfession,
getStoryProposals: () => generatedStoryProposals,
getStoryPreference: () => adventureStoryPreference,
getSelectedStoryProposalId: () => selectedStoryProposalId,
setStoryPreference: value => { adventureStoryPreference = value; }
```

- [ ] **Step 2: Add failing parser and lock tests**

Add assertions using fenced JSON with one malformed entry:

```js
const rawProposals = '```json\n' + JSON.stringify({ proposals: [
  { title: '雾城余烬', pitch: '追查失踪案', world: '永夜都市', playerIdentity: '新来的调查员', profession: '剑士', location: '旧城区', goal: '找到失踪者', toneTags: ['悬疑'], cast: [{ name: '艾莉', role: '向导', relationship: '互不信任' }], openingHook: '钟楼传来求救声', other: '' },
  { title: '王庭暗潮', world: '衰败王国', playerIdentity: '流亡者', location: '边境酒馆', goal: '活过今晚', openingHook: '刺客撞开酒馆门' },
  null
] }) + '\n```';
const parsed = api.parseStoryProposals(rawProposals, '黑客');
check('方案解析保留两套合法对象', parsed.length === 2);
check('方案标题完成归一化', parsed[0].title === '雾城余烬');
check('锁定职业覆盖 AI 职业', parsed.every(p => p.profession === '黑客'));
check('缺省数组字段被补齐', Array.isArray(parsed[1].toneTags) && Array.isArray(parsed[1].cast));
```

- [ ] **Step 3: Run the focused test and confirm failure**

Run: `node .workbuddy/tmp/test_adventure_wizard.js`

Expected: FAIL because `parseStoryProposals` and session state are not defined.

- [ ] **Step 4: Add minimal session state and parser implementation**

Add near `pendingLoadCards/pendingLoadBooks`:

```js
let adventureStoryPreference = '';
let generatedStoryProposals = [];
let selectedStoryProposalId = null;
let storyProposalGenerating = false;
let adventureTitleDraft = '';
let adventureOpeningHook = '';

function resetAdventureCreationSession() {
  adventureStoryPreference = '';
  generatedStoryProposals = [];
  selectedStoryProposalId = null;
  storyProposalGenerating = false;
  adventureTitleDraft = '';
  adventureOpeningHook = '';
}

function getLockedProfession() {
  const input = document.getElementById('customProfessionInput');
  const value = String((input && input.value) || customProfession || '').trim();
  return value;
}
```

Implement `normalizeStoryProposal` with string trimming, array normalization, stable `proposal_1` IDs, Chinese fallback labels, and client-side profession override. Implement `parseStoryProposals` by removing code fences, extracting the outer JSON value, accepting either `{proposals:[...]}` or `[...]`, filtering non-object entries, and returning at most three normalized proposals.

- [ ] **Step 5: Run the focused test and confirm parser behavior passes**

Run: `node .workbuddy/tmp/test_adventure_wizard.js`

Expected: parser and profession-lock assertions PASS; legacy step assertions may still fail until Task 2.

---

### Task 2: Three-Step Modal Structure and Navigation

**Files:**
- Modify: `app/index.html:124`
- Modify: `app/app.js:5199`
- Modify: `app/app.js:5404`
- Test: `.workbuddy/tmp/test_adventure_wizard.js:70`

**Interfaces:**
- Consumes: `resetAdventureCreationSession`, existing `renderThemeGrid`, `renderLoadLibrary`, `pendingLoadCards`, `pendingLoadBooks`.
- Produces: `goAdventureStep(step: 1|2|3): void`
- Produces: `renderSelectedMaterialTray(): void`
- Produces: `syncAdventurePreference(): void`
- Produces: `skipStoryProposalGeneration(): void`

- [ ] **Step 1: Replace two-step test assertions with three-step assertions**

Assert:

```js
api.goAdventureStep(1);
check('第1步仅显示素材页', elements.advStep1.style.display !== 'none' && elements.advStep2.style.display === 'none' && elements.advStep3.style.display === 'none');
api.goAdventureStep(2);
check('第2步仅显示方案页', elements.advStep1.style.display === 'none' && elements.advStep2.style.display !== 'none' && elements.advStep3.style.display === 'none');
api.goAdventureStep(3);
check('第3步仅显示确认页', elements.advStep1.style.display === 'none' && elements.advStep2.style.display === 'none' && elements.advStep3.style.display !== 'none');
```

Add a test that `showNewAdventureModal()` resets preference/proposals but returning from step 2 to step 1 does not.

- [ ] **Step 2: Run the focused test and confirm navigation failure**

Run: `node .workbuddy/tmp/test_adventure_wizard.js`

Expected: FAIL because `advStep3` and three-step footer behavior do not exist.

- [ ] **Step 3: Replace modal markup with three step containers**

In `app/index.html`:

- Change step labels to `选择素材 / 故事方案 / 确认开局`.
- Remove `advGuide` and open directly on step 1.
- Keep theme, mode, character name, profession, material browser in `advStep1`.
- Remove the visible `adventureSetting` textarea but retain `<textarea id="adventureSetting" hidden></textarea>` as the existing composed-setting sink.
- Add `<div id="selectedMaterialTray"></div>` and `<textarea id="storyPreferenceInput">`.
- Add `<div id="storyProposalStatus"></div>` and `<div id="storyProposalGrid"></div>` in `advStep2`.
- Move `<div id="advPreview"></div>` into new `advStep3`.
- Add secondary `skipStoryProposalGeneration()` control.

- [ ] **Step 4: Implement three-step navigation and reset behavior**

Update `goAdventureStep` to show exactly one step, mark completed/current indicators, render proposals on step 2, and call `renderAdventureEditor()` on step 3. Update footer rules:

- Step 1: show Generate button only.
- Step 2: show Previous only; proposal cards perform forward navigation.
- Step 3: show Previous and Start.

Update `showNewAdventureModal()` to call `resetAdventureCreationSession()`, clear `storyPreferenceInput`, open step 1 immediately, and retain existing theme/material resets.

- [ ] **Step 5: Render selected materials and preference state**

`renderSelectedMaterialTray()` must render compact removable chips from both pending arrays and update after `toggleLoadItem`, `toggleLoadGroup`, and removal. `syncAdventurePreference()` copies the textarea value into `adventureStoryPreference`. `skipStoryProposalGeneration()` creates one blank normalized proposal, selects it, and opens step 3 without an API call.

- [ ] **Step 6: Run the focused test and confirm all navigation tests pass**

Run: `node .workbuddy/tmp/test_adventure_wizard.js`

Expected: three-step, reset, retention, and legacy material-card tests PASS.

---

### Task 3: AI Proposal Generation and Choice Cards

**Files:**
- Modify: `app/app.js:1474`
- Modify: `app/app.js:5478`
- Test: `.workbuddy/tmp/test_adventure_wizard.js`

**Interfaces:**
- Consumes: `callLLM(messages)`, `getLockedProfession`, `pendingLoadCards`, `pendingLoadBooks`, `adventureStoryPreference`, `parseStoryProposals`.
- Produces: `buildStoryProposalMessages(): Array<{role:string,content:string}>`
- Produces: `generateStoryProposals(): Promise<void>`
- Produces: `renderStoryProposalChoices(): void`
- Produces: `selectStoryProposal(id: string): void`

- [ ] **Step 1: Add failing prompt, generation, and retention tests**

Expose the four interfaces in the harness. Stub `callLLM` through a replaceable wrapper or expose `setStoryProposalCall` for tests. Assert that the request contains selected card names, selected book titles, the preference, and the locked profession. Assert a rejected call leaves pending arrays and preference unchanged.

Use this response fixture:

```js
JSON.stringify({ proposals: [
  { title: '灰烬王冠', pitch: '王国最后一夜', world: '王都被灰雾吞噬', playerIdentity: '失忆的继承人', profession: '剑士', location: '封锁城门', goal: '找到王冠真相', toneTags: ['冒险', '阴谋'], cast: [{ name: '艾莉', role: '护卫', relationship: '忠诚但隐瞒真相' }], openingHook: '守城钟在无人敲击时响起', other: '' },
  { title: '旅店第七封信', pitch: '从角色关系切入', world: '边境旅店连接多个世界', playerIdentity: '新任店主', profession: '剑士', location: '无名旅店', goal: '找出写信人', toneTags: ['关系', '慢热'], cast: [], openingHook: '第七封信写着玩家的死期', other: '' },
  { title: '无月档案', pitch: '调查被抹去的城市', world: '城市每天失去一段记忆', playerIdentity: '唯一保留记忆的人', profession: '剑士', location: '档案馆', goal: '阻止下一次遗忘', toneTags: ['悬疑'], cast: [], openingHook: '档案中出现明天的死亡记录', other: '' }
] })
```

- [ ] **Step 2: Run the focused test and confirm generation functions fail**

Run: `node .workbuddy/tmp/test_adventure_wizard.js`

Expected: FAIL because proposal generation interfaces are undefined.

- [ ] **Step 3: Implement prompt construction**

Build two messages:

```js
[
  { role: 'system', content: '你是文字冒险开局策划。只返回 JSON，不要解释。生成三套在主要冲突、玩家身份、开局事件和叙事重心上明显不同的方案。' },
  { role: 'user', content: JSON.stringify({ theme, mode, playerName, lockedProfession, preference, cards, books, outputSchema }) }
]
```

Limit each role-card summary to 1200 characters and each world-book content to 2400 characters, with no more than five books included in full. Include all selected titles even when content is truncated.

- [ ] **Step 4: Implement generation lifecycle**

`generateStoryProposals()` must:

1. Sync preference and custom profession from DOM.
2. Open settings without clearing state if API configuration is missing.
3. Set `storyProposalGenerating=true`, disable the Generate button, and render progress text.
4. Call `callLLM` once.
5. Parse and require at least one proposal.
6. Save proposals and open step 2.
7. On error, keep all inputs, render an inline error, and expose retry.
8. Restore buttons in `finally`.

- [ ] **Step 5: Implement safe proposal card rendering and selection**

Render escaped title, pitch, fields, tags, and cast summaries. `selectStoryProposal(id)` stores the ID, applies the proposal to draft fields, then opens step 3. Add `重新生成 3 套` and `返回选择素材` actions.

- [ ] **Step 6: Run the focused test and confirm generation tests pass**

Run: `node .workbuddy/tmp/test_adventure_wizard.js`

Expected: prompt inputs, three cards, lock override, error retention, and selection tests PASS.

---

### Task 4: Confirmation Mapping, Adventure Title, Opening Hook, and Profession Root Fix

**Files:**
- Modify: `app/app.js:481`
- Modify: `app/app.js:4788`
- Modify: `app/app.js:5000`
- Modify: `app/app.js:5229`
- Test: `.workbuddy/tmp/test_adventure_wizard.js`

**Interfaces:**
- Consumes: selected `StoryProposal`, existing `settingParts`, `state.adventureLocationOverride`, `createAdventure`, `beginAdventureOpening`.
- Produces: `applyStoryProposal(proposal): void`
- Produces: `renderAdventureEditor(): void` as the step-3 confirmation renderer.
- Produces: `bindAdventureEditor(box): void` updated for title and hook.

- [ ] **Step 1: Add failing mapping and creation tests**

Assert:

```js
api.setCustomProfession('黑客');
api.applyStoryProposal(parsed[0]);
check('方案标题写入草稿', api.getAdventureTitleDraft() === '雾城余烬');
check('世界背景写入 settingParts', api.getSettingParts().world === '永夜都市');
check('开局钩子写入草稿', api.getAdventureOpeningHook() === '钟楼传来求救声');
check('方案职业不能覆盖锁定职业', api.getLockedProfession() === '黑客');
```

Create an adventure through a testable helper and assert `adv.title === '雾城余烬'`, `adv.character.profession === '黑客'`, and `adv.openingSeed === '钟楼传来求救声'` after opening begins.

- [ ] **Step 2: Run the focused test and confirm mapping failure**

Run: `node .workbuddy/tmp/test_adventure_wizard.js`

Expected: FAIL because title/hook mapping and reliable profession precedence are absent.

- [ ] **Step 3: Fix the custom-profession root cause**

Remove the misplaced block in `sendNextStep()` that references undefined `opts`. In `startNewAdventure()`, immediately after `const opts = ...`, resolve:

```js
const lockedProfession = getLockedProfession();
if (lockedProfession) {
  customProfession = lockedProfession;
  state.selectedProfession = null;
  opts.profession = {
    name: lockedProfession,
    attrs: { 力量: 10, 敏捷: 10, 智力: 10, 魅力: 10, 幸运: 10 },
    skills: []
  };
}
```

Never mutate `customProfession` from proposal data when a locked value exists.

- [ ] **Step 4: Map selected proposal into confirmation fields**

`applyStoryProposal` writes title, hook, world, identity, goal, other, location, and unlocked recommended profession. Update `renderAdventureEditor` to render compact sections with `pvTitle`, `pvWorld`, `pvIdentity`, `pvLoc`, `pvGoal`, `pvOpeningHook`, `pvOther`, player name, and profession lock badge. Render selected characters/books as summaries rather than full raw editors.

- [ ] **Step 5: Bind confirmation edits**

Update `bindAdventureEditor` so title and hook edit `adventureTitleDraft` and `adventureOpeningHook`; existing setting/location/name binding remains. When custom profession is locked, render a read-only field and do not render a selectable profession control.

- [ ] **Step 6: Persist only selected proposal output**

After `createAdventure`:

```js
adv.title = adventureTitleDraft.trim() || ((adv.character && adv.character.name) ? adv.character.name + '的冒险' : '未命名冒险');
updateSystemPrompt(adv);
saveState();
```

If `adventureOpeningHook` is non-empty, call `beginAdventureOpening(adv, adventureOpeningHook)` directly and skip the alternate-greeting modal. Otherwise preserve existing greeting selection behavior.

- [ ] **Step 7: Run focused tests and confirm mapping passes**

Run: `node .workbuddy/tmp/test_adventure_wizard.js`

Expected: title, field mapping, profession lock, confirmation edits, and opening-hook precedence PASS.

---

### Task 5: Visual Polish, Documentation, and Full Verification

**Files:**
- Modify: `app/redesign.css`
- Modify: `代码指南.md:170`
- Modify: `项目协作日志.md:66`
- Test: `.workbuddy/tmp/test_adventure_wizard.js`

**Interfaces:**
- Consumes: final DOM class names from Tasks 2–4.
- Produces: responsive three-step visual hierarchy and final project documentation.

- [ ] **Step 1: Add wizard-specific styles**

Add styles for:

```css
.adv-material-layout
.adv-player-card
.selected-material-tray
.selected-material-chip
.story-preference-card
.story-proposal-status
.story-proposal-grid
.story-proposal-card
.story-proposal-card__tags
.story-proposal-card__cast
.profession-lock-badge
.adv-confirm-grid
.adv-confirm-section
```

Use a three-column proposal grid at desktop widths, one column below 900px, existing color variables, visible focus states, and no new external assets.

- [ ] **Step 2: Run syntax and focused regression**

Run:

```powershell
node --check app/app.js
node .workbuddy/tmp/test_adventure_wizard.js
```

Expected: syntax exit 0 and all wizard assertions pass.

- [ ] **Step 3: Run adjacent online-adventure regressions**

Run:

```powershell
node .workbuddy/tmp/test_new_features.js
node .workbuddy/tmp/test_ai_path.js
node .workbuddy/tmp/test_denova_export.js
```

Expected: all three scripts exit 0 with zero failures.

- [ ] **Step 4: Update the code guide**

In `代码指南.md`, replace the two-page creation flow with the three-step data flow, list all new temporary state and function names, document title/opening-hook mapping, and record the custom-profession root cause: the override block was in `sendNextStep` where `opts` did not exist instead of `startNewAdventure` where adventure options are assembled.

- [ ] **Step 5: Add the final collaboration-log entry**

Insert one row at the top of “功能与修改记录” using the current exact time. Include:

- Three-step wizard.
- Three AI-generated plans and editable automatic titles.
- Optional preference input.
- Locked custom profession root fix.
- Selected-material summaries and confirmation layout.
- Files changed.
- Exact syntax/test commands and pass/fail totals.

- [ ] **Step 6: Re-run verification after documentation edits**

Run:

```powershell
node --check app/app.js
node .workbuddy/tmp/test_adventure_wizard.js
node .workbuddy/tmp/test_new_features.js
node .workbuddy/tmp/test_ai_path.js
node .workbuddy/tmp/test_denova_export.js
```

Expected: every command exits 0. If an unrelated pre-existing failure appears, report it without changing unrelated code.

