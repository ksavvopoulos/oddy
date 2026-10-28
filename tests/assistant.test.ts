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
import {
  recordProposal,
  flowProposal,
  membershipProposal,
  skillProposal
} from './fixtures/proposals';
import { bulkSummary } from './fixtures/bulk';
import { definitionProposal } from './fixtures/flow-definitions';

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
  it('exposes one definition format with explicit nullable fields instead of competing specs', () => {
    const schema = DATAVERSE_TOOLS.find(
      (tool) => tool.function.name === 'prepare_dataverse_flow_change'
    )!.function.parameters;
    expect(schema).toMatchObject({
      required: ['operation', 'workflowId', 'etag', 'definition'],
      properties: {
        workflowId: { type: ['string', 'null'] },
        etag: { type: ['string', 'null'] },
        definition: {
          required: ['name', 'description', 'clientData'],
          properties: { description: { type: ['string', 'null'] } }
        }
      }
    });
    expect(schema.properties).not.toHaveProperty('spec');
  });

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
      'prepare_dataverse_flow_change',
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
        action: 'prepare_flow_change',
        flowChange: flowProposal
      })
      .mockResolvedValueOnce({
        ok: true,
        action: 'prepare_list_membership',
        listMembership: membershipProposal
      })
      .mockResolvedValueOnce({ ok: true, action: 'prepare_skill_change', change: skillProposal });
    const result = await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, true, true);
    expect(result.pendingMutations).toEqual([recordProposal]);
    expect(result.pendingFlowChanges).toEqual([flowProposal]);
    expect(result.pendingListMemberships).toEqual([membershipProposal]);
    expect(result.pendingSkillChanges).toEqual([skillProposal]);
    expect(result.toolsUsed).toHaveLength(4);
    expect(vi.mocked(executeAssistantTool).mock.calls.map((call) => call[1])).toEqual(calls);
    expect(vi.mocked(callAzureOpenAIResponses).mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ previousResponseId: 'response-1' })
    );
    expect(JSON.stringify(vi.mocked(callAzureOpenAIResponses).mock.calls[1]?.[1])).not.toContain(
      'generatedClientData'
    );
  });

  it('collects a general flow definition proposal for approval without executing it', async () => {
    vi.mocked(callAzureOpenAIResponses)
      .mockResolvedValueOnce({
        id: 'general-1',
        toolCalls: [
          {
            type: 'function_call',
            call_id: 'flow',
            name: 'prepare_dataverse_flow_change',
            arguments: '{}'
          }
        ]
      })
      .mockResolvedValueOnce({
        id: 'general-2',
        content: 'Review the proposed changes.',
        toolCalls: []
      });
    vi.mocked(executeAssistantTool).mockResolvedValueOnce({
      ok: true,
      action: 'prepare_flow_change',
      flowChange: definitionProposal
    });
    const result = await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, true, true);
    expect(result.pendingFlowChanges).toEqual([definitionProposal]);
    expect(executeAssistantTool).toHaveBeenCalledTimes(1);
    expect(result.toolsUsed?.[0]?.summary).toContain('awaiting approval');
    const output = JSON.stringify(vi.mocked(callAzureOpenAIResponses).mock.calls[1]?.[1]);
    expect(output).toContain('clientData');
    expect(output).not.toContain('generatedClientData');
  });

  it('keeps flow paging metadata in read-only tool outputs across an empty matching page', async () => {
    vi.mocked(callAzureOpenAIResponses)
      .mockResolvedValueOnce({
        id: 'flow-page-1',
        toolCalls: [
          {
            type: 'function_call',
            call_id: 'page-1',
            name: 'list_dataverse_flows',
            arguments: JSON.stringify({
              trigger: { table: 'cr_voucher', event: 'create' },
              definitionScope: 'published'
            })
          }
        ]
      })
      .mockResolvedValueOnce({
        id: 'flow-page-2',
        toolCalls: [
          {
            type: 'function_call',
            call_id: 'page-2',
            name: 'list_dataverse_flows',
            arguments: JSON.stringify({ cursor: 'opaque-next' })
          }
        ]
      })
      .mockResolvedValueOnce({
        id: 'flow-done',
        content:
          'One published, enabled voucher-creation trigger was found. This does not confirm a run.',
        toolCalls: []
      });
    const page = {
      definitionScope: 'published' as const,
      pageSize: 100,
      scanned: 100,
      returned: 0,
      uninspectable: 0,
      hasMore: true,
      nextCursor: 'opaque-next',
      warnings: ['More candidate pages remain.'],
      inspectionIssues: []
    };
    vi.mocked(executeAssistantTool)
      .mockResolvedValueOnce({ ok: true, action: 'list_flows', flows: [], flowPage: page })
      .mockResolvedValueOnce({
        ok: true,
        action: 'list_flows',
        flowPage: { ...page, scanned: 1, returned: 1, hasMore: false, nextCursor: undefined },
        flows: [
          {
            workflowId: 'flow-id',
            name: 'Voucher creation',
            state: 'activated',
            isManaged: false,
            oddyEditable: true,
            definitionVersion: 'published',
            triggerInspection: 'complete',
            triggers: [
              {
                id: 'On_row',
                type: 'OpenApiConnectionWebhook',
                table: 'cr_voucher',
                events: ['create'],
                inspection: 'recognized'
              }
            ]
          }
        ]
      });
    const result = await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, true, false);
    expect(executeAssistantTool).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(executeAssistantTool)
        .mock.calls.every(([, name]) => name === 'list_dataverse_flows')
    ).toBe(true);
    expect(result.pendingFlowChanges).toBeUndefined();
    expect(result.toolsUsed?.[0]?.summary).toContain('more pages remain');
    expect(result.toolsUsed?.[1]?.summary).toContain('last page');
    expect(JSON.stringify(vi.mocked(callAzureOpenAIResponses).mock.calls[1]?.[1])).toContain(
      'opaque-next'
    );
    expect(JSON.stringify(vi.mocked(callAzureOpenAIResponses).mock.calls[0]?.[1])).toContain(
      'not a flow-name or action-text substring'
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

  it('collects a compact bulk preview without exposing an executor or row arrays', async () => {
    const job = bulkSummary({
      matched: 12000,
      total: 12000,
      remaining: 12000,
      sample: [
        {
          recordId: 'private-row',
          recordName: 'Private example name',
          before: { secret: 'private-value' },
          after: { secret: 'new-private-value' }
        }
      ]
    });
    vi.mocked(callAzureOpenAIResponses)
      .mockResolvedValueOnce({
        id: 'bulk-prepare',
        toolCalls: [
          { type: 'function_call', call_id: 'bulk', name: 'prepare_bulk_job', arguments: '{}' }
        ]
      })
      .mockResolvedValueOnce({
        id: 'bulk-done',
        content: 'Approve the frozen job.',
        toolCalls: []
      });
    vi.mocked(executeAssistantTool).mockResolvedValue({
      ok: true,
      action: 'prepare_bulk_job',
      job
    });
    const result = await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, true, false);
    expect(result.pendingBulkJobs).toEqual([job]);
    const output = JSON.stringify(vi.mocked(callAzureOpenAIResponses).mock.calls[1]?.[1].input);
    expect(output.length).toBeLessThan(3000);
    expect(output).not.toContain('runToken');
    expect(output).not.toContain('private-value');
    expect(output).not.toContain('Private example name');
    expect(output).not.toContain('"rows"');
    expect(vi.mocked(executeAssistantTool).mock.calls.map((call) => call[1])).toEqual([
      'prepare_bulk_job'
    ]);
  });

  it('supplies the signed-in user time settings automatically and audits the read', async () => {
    vi.mocked(getActiveDataverseContext).mockResolvedValue({
      isDataverse: true,
      source: 'url',
      origin: recordProposal.environmentOrigin,
      fields: [],
      capturedAt: 'now',
      currentUser: {
        source: 'webApi',
        observedAtUtc: '2026-01-15T23:30:00Z',
        timeZoneCode: 130,
        timeZoneStandardName: 'GTB Standard Time',
        localDate: '2026-01-16'
      }
    });
    vi.mocked(callAzureOpenAIResponses).mockResolvedValue({
      id: 'done',
      content: 'The user date is known.',
      toolCalls: []
    });
    const result = await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, true, false);
    expect(getActiveDataverseContext).toHaveBeenCalledWith({ includeUserSettings: true });
    const sent = vi.mocked(callAzureOpenAIResponses).mock.calls[0]?.[1].messages;
    expect(sent?.[0]?.content).toContain('"localDate":"2026-01-16"');
    expect(sent?.[0]?.content).toContain('GTB Standard Time');
    expect(result.toolsUsed?.[0]).toMatchObject({
      name: 'read_dataverse_user_settings',
      label: 'Read current user time settings'
    });
  });

  it('does not expose Dataverse user settings when only custom-skill tools are enabled', async () => {
    vi.mocked(getActiveDataverseContext).mockResolvedValue({
      isDataverse: true,
      source: 'url',
      fields: [],
      capturedAt: 'now',
      currentUser: {
        source: 'webApi',
        observedAtUtc: '2026-01-15T23:30:00Z',
        timeZoneStandardName: 'Private configured zone'
      }
    });
    vi.mocked(callAzureOpenAIResponses).mockResolvedValue({
      id: 'done',
      content: 'Skills only.',
      toolCalls: []
    });
    await runDataverseAssistant(DEFAULT_SETTINGS.azureOpenAI, messages, false, true);
    expect(getActiveDataverseContext).toHaveBeenCalledWith({ includeUserSettings: false });
    expect(JSON.stringify(vi.mocked(callAzureOpenAIResponses).mock.calls[0]?.[1])).not.toContain(
      'Private configured zone'
    );
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
