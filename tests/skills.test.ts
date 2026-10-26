import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_SKILLS,
  buildOddyWorkflow,
  buildSkillExecutionInstruction,
  buildSkillMarkdown,
  executeOddySkillChange,
  prepareOddySkillChange,
  SKILLS_KEY,
  skillInputFromParts,
  skillRevision,
  validateSkill,
  validateSkillRunInputs
} from '../lib/skills';
import type { OddySkill } from '../lib/types';

afterEach(() => vi.unstubAllGlobals());

const customSkill: OddySkill = {
  id: 'review-inactive-contacts',
  name: 'Review inactive contacts',
  description: 'Find inactive contacts and open a review view.',
  version: '1.0',
  source: 'user',
  enabled: true,
  instructions: 'Use the supplied number of days and explain the resulting filter.',
  allowedTools: ['resolve_dataverse_schema', 'manage_dataverse_view', 'navigate_dataverse'],
  inputs: [{ id: 'inactiveDays', label: 'Inactive days', type: 'number', required: true }],
  steps: [
    { id: 'step-1', instruction: 'Resolve the contact table and modified date column.' },
    { id: 'step-2', instruction: 'Create the filtered AI Result view.' },
    { id: 'step-3', instruction: 'Navigate to the view.' }
  ]
};

describe('Oddy skills', () => {
  it('provides guarded built-in marketing-list skills', () => {
    expect(BUILT_IN_SKILLS).toHaveLength(2);
    expect(BUILT_IN_SKILLS[0]).toMatchObject({
      id: 'create-marketing-list',
      allowedTools: ['resolve_dataverse_schema', 'prepare_dataverse_record_change']
    });
    expect(BUILT_IN_SKILLS[1]).toMatchObject({
      id: 'add-marketing-list-members',
      allowedTools: ['query_dataverse_records', 'prepare_bulk_job']
    });
    expect(BUILT_IN_SKILLS[1]?.instructions).toContain('bounded AddListMembersList requests');
  });

  it('validates inputs before building skill execution instructions', () => {
    expect(validateSkill(customSkill)).toEqual([]);
    expect(validateSkillRunInputs(customSkill, { inactiveDays: 'not-a-number' })).toEqual([
      'Inactive days must be a number.'
    ]);

    const instruction = buildSkillExecutionInstruction(customSkill, {
      skillId: customSkill.id,
      inputValues: { inactiveDays: '30' }
    });
    expect(instruction).toContain('"inactiveDays": "30"');
    expect(instruction).toContain('Follow this workflow in order');
  });

  it('exports standard skill metadata and an Oddy workflow', () => {
    const markdown = buildSkillMarkdown(customSkill);
    expect(markdown).toContain('name: review-inactive-contacts');
    expect(markdown).toContain(
      'allowed-tools: resolve_dataverse_schema manage_dataverse_view navigate_dataverse'
    );
    expect(buildOddyWorkflow(customSkill)).toEqual(
      expect.objectContaining({
        version: 1,
        skill: 'review-inactive-contacts',
        steps: customSkill.steps
      })
    );
  });

  it('parses builder input definitions', () => {
    expect(
      skillInputFromParts(['status', 'Status', 'select', 'active, inactive', 'optional'])
    ).toEqual({
      id: 'status',
      label: 'Status',
      type: 'select',
      required: false,
      options: ['active', 'inactive']
    });
  });

  it('prepares and applies custom skill updates only after approval', async () => {
    const storage: Record<string, unknown> = { [SKILLS_KEY]: [customSkill] };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (values: Record<string, unknown>) => Object.assign(storage, values))
        }
      }
    });

    const change = await prepareOddySkillChange({
      operation: 'update',
      skillId: customSkill.id,
      baseRevision: skillRevision(customSkill),
      skill: {
        ...customSkill,
        instructions: 'Use the supplied days, explain the filter, and sort newest first.'
      }
    });

    expect(change.before?.instructions).toBe(customSkill.instructions);
    expect(change.after?.version).toBe('1.1');
    expect((storage[SKILLS_KEY] as OddySkill[])[0]?.instructions).toBe(customSkill.instructions);

    const result = await executeOddySkillChange(change);
    expect(result).toEqual({
      operation: 'update',
      skillId: customSkill.id,
      skillName: customSkill.name
    });
    expect((storage[SKILLS_KEY] as OddySkill[])[0]?.instructions).toContain('sort newest first');
    await expect(executeOddySkillChange(change)).rejects.toThrow(/changed after the preview/);
  });

  it('does not prepare modifications to bundled skills', async () => {
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({ [SKILLS_KEY]: [] })),
          set: vi.fn()
        }
      }
    });

    await expect(
      prepareOddySkillChange({
        operation: 'update',
        skillId: 'create-marketing-list',
        skill: BUILT_IN_SKILLS[0]
      })
    ).rejects.toThrow(/Bundled skills cannot be modified/);
  });
});
