import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callAzureOpenAI, callAzureOpenAIResponses } from '../lib/azure-openai';
import { getActiveDataverseContext } from '../lib/browser/context';
import { executeAssistantTool } from '../lib/assistant/execute-tool';
import { runDataverseAssistant } from '../lib/assistant/run';
import {
  DATAVERSE_TOOLS,
  ODDY_SKILL_TOOLS,
  selectAssistantTools,
  SKILL_TOOL_OPTIONS
} from '../lib/assistant/tool-catalog';
import { DEFAULT_SETTINGS } from '../lib/storage';
import { BUILT_IN_SKILLS } from '../lib/skills';
import { recordProposal, membershipProposal, skillProposal } from './fixtures/proposals';

vi.mock('../lib/azure-openai', () => ({
  callAzureOpenAI: vi.fn(),
  callAzureOpenAIResponses: vi.fn()
}));
vi.mock('../lib/browser/context', () => ({ getActiveDataverseContext: vi.fn() }));
vi.mock('../lib/assistant/execute-tool', () => ({ executeAssistantTool: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getActiveDataverseContext).mockResolvedValue({
    isDataverse: true,
    source: 'url',
    origin: recordProposal.environmentOrigin,
    fields: [],
    capturedAt: 'now'
  });
});
const messages = [{ role: 'user' as const, content: 'Help' }];
const names = (tools: typeof DATAVERSE_TOOLS) => tools.map((tool) => tool.function.name);

describe('assistant tool catalog', () => {
  it('keeps skill-builder choices and advertised tools synchronized and unique', () => {
    expect(names(DATAVERSE_TOOLS)).toEqual(SKILL_TOOL_OPTIONS.map((option) => option.name));
    expect(new Set(names(DATAVERSE_TOOLS)).size).toBe(DATAVERSE_TOOLS.length);
    expect(
      [...names(DATAVERSE_TOOLS), ...names(ODDY_SKILL_TOOLS)].some(
        (name) => name.startsWith('execute_') && name !== 'execute_dataverse_view'
      )
    ).toBe(false);
  });

  it('honors tool consent and restricts skill runs to declared Dataverse tools', () => {
    expect(selectAssistantTools({ allowDataverseTools: false, allowSkillTools: false })).toEqual(
      []
    );
    expect(selectAssistantTools({ allowDataverseTools: false, allowSkillTools: true })).toEqual(
      ODDY_SKILL_TOOLS
    );
    expect(
      names(
        selectAssistantTools({
          allowDataverseTools: true,
          allowSkillTools: true,
          skillTools: ['query_dataverse_records']
        })
      )
    ).toEqual(['query_dataverse_records']);
    expect(
      selectAssistantTools({
        allowDataverseTools: false,
        allowSkillTools: true,
        skillTools: ['query_dataverse_records']
      })
    ).toEqual([]);
  });

  it('builds the skill-management enum and limits from the same catalog', () => {
    const definition = ODDY_SKILL_TOOLS.find(
      (tool) => tool.function.name === 'prepare_oddy_skill_change'
    )!;
    const schema = JSON.stringify(definition.function.parameters);
    for (const option of SKILL_TOOL_OPTIONS) expect(schema).toContain(option.name);
    expect(schema).toContain(`"maxItems":${SKILL_TOOL_OPTIONS.length}`);
  });
});

describe('assistant orchestration', () => {
  it('bypasses browser inspection when no tools are permitted', async () => {
    vi.mocked(callAzureOpenAI).mockResolvedValue({ content: 'Hello' });
    expect(
      await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, false, false)
    ).toEqual({ content: 'Hello' });
    expect(getActiveDataverseContext).not.toHaveBeenCalled();
    expect(executeAssistantTool).not.toHaveBeenCalled();
  });

  it('collects each kind of proposal without executing its mutation', async () => {
    const calls = [
      'prepare_dataverse_record_change',
      'prepare_marketing_list_membership',
      'prepare_oddy_skill_change'
    ];
    vi.mocked(callAzureOpenAIResponses)
      .mockResolvedValueOnce({
        id: 'response-1',
        toolCalls: calls.map((name, i) => ({
          type: 'function_call',
          call_id: String(i),
          name,
          arguments: '{}'
        }))
      })
      .mockResolvedValueOnce({ id: 'response-2', content: 'Awaiting approval', toolCalls: [] });
    vi.mocked(executeAssistantTool)
      .mockResolvedValueOnce({ ok: true, action: 'prepare_mutation', mutation: recordProposal })
      .mockResolvedValueOnce({
        ok: true,
        action: 'prepare_list_membership',
        listMembership: membershipProposal
      })
      .mockResolvedValueOnce({ ok: true, action: 'prepare_skill_change', change: skillProposal });
    const result = await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, true, true);
    expect(result.pendingMutations).toEqual([recordProposal]);
    expect(result.pendingListMemberships).toEqual([membershipProposal]);
    expect(result.pendingSkillChanges).toEqual([skillProposal]);
    expect(result.toolsUsed).toHaveLength(3);
    expect(vi.mocked(executeAssistantTool).mock.calls.map((call) => call[1])).toEqual(calls);
    expect(vi.mocked(callAzureOpenAIResponses).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ previousResponseId: 'response-1' })
    );
  });

  it('rejects unadvertised calls before dispatch, including approval execution', async () => {
    vi.mocked(callAzureOpenAIResponses)
      .mockResolvedValueOnce({
        id: 'r1',
        toolCalls: [
          { type: 'function_call', call_id: 'bad', name: 'execute_mutation', arguments: '{}' }
        ]
      })
      .mockResolvedValueOnce({ id: 'r2', content: 'Not allowed', toolCalls: [] });
    const result = await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, true, false);
    expect(executeAssistantTool).not.toHaveBeenCalled();
    expect(result.toolsUsed?.[0]?.summary).toBe('Failed');
    const payload = JSON.stringify(vi.mocked(callAzureOpenAIResponses).mock.calls[1]?.[1]);
    expect(payload).toContain('not enabled for this request');
  });

  it('rejects a valid tool outside the active skill allowlist', async () => {
    vi.mocked(callAzureOpenAIResponses)
      .mockResolvedValueOnce({
        id: 'r1',
        toolCalls: [
          {
            type: 'function_call',
            call_id: 'bad',
            name: 'query_dataverse_records',
            arguments: '{}'
          }
        ]
      })
      .mockResolvedValueOnce({ id: 'r2', content: 'Not allowed', toolCalls: [] });
    const skill = BUILT_IN_SKILLS[0]!;
    await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, true, false, 'request', {
      skill,
      run: {
        skillId: skill.id,
        inputValues: { listName: 'Test', listType: 'static', memberType: 'contact' }
      }
    });
    expect(executeAssistantTool).not.toHaveBeenCalled();
    expect(names(vi.mocked(callAzureOpenAIResponses).mock.calls[0]![1].tools || [])).toEqual(
      skill.allowedTools
    );
  });

  it('supplies the worker clock even when Dataverse tools are disabled', async () => {
    vi.mocked(callAzureOpenAI).mockResolvedValue({ content: 'Today is known.' });
    await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, false, false);
    const sent = vi.mocked(callAzureOpenAI).mock.calls[0]?.[1];
    expect(sent?.[0]?.content).toContain('Extension clock (authoritative');
    expect(sent?.[0]?.content).toContain('rolling30Days');
    expect(messages).toEqual([{ role: 'user', content: 'Help' }]);
  });

  it('stops a continuation before model calls when the active environment changed', async () => {
    await expect(
      runDataverseAssistant(
        DEFAULT_SETTINGS.azureOpenAI,
        messages,
        true,
        false,
        undefined,
        undefined,
        {
          expectedOrigin: 'https://other.crm.dynamics.com'
        }
      )
    ).rejects.toThrow('environment changed');
    expect(callAzureOpenAIResponses).not.toHaveBeenCalled();
    expect(executeAssistantTool).not.toHaveBeenCalled();
  });

  it('intersects a resumed skill with its original tool ceiling', async () => {
    vi.mocked(callAzureOpenAIResponses).mockResolvedValue({
      id: 'done',
      content: 'Done.',
      toolCalls: []
    });
    const skill = BUILT_IN_SKILLS[0]!;
    await runDataverseAssistant(
      DEFAULT_SETTINGS.azureOpenAI,
      messages,
      true,
      false,
      undefined,
      {
        skill,
        run: {
          skillId: skill.id,
          inputValues: { listName: 'Test', listType: 'static', memberType: 'contact' }
        }
      },
      { skillToolLimit: ['resolve_dataverse_schema'] }
    );
    expect(names(vi.mocked(callAzureOpenAIResponses).mock.calls[0]?.[1].tools || [])).toEqual([
      'resolve_dataverse_schema'
    ]);
  });

  it('stops a runaway model tool loop', async () => {
    vi.mocked(callAzureOpenAIResponses).mockResolvedValue({
      id: 'r',
      toolCalls: [
        { type: 'function_call', call_id: 'call', name: 'query_dataverse_records', arguments: '{}' }
      ]
    });
    vi.mocked(executeAssistantTool).mockResolvedValue({
      ok: true,
      action: 'query_records',
      records: []
    });
    await expect(
      runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, true, false)
    ).rejects.toThrow('maximum number');
    expect(executeAssistantTool).toHaveBeenCalledTimes(12);
  });
});
