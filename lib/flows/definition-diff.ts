import type { DataverseFlowDefinition } from './contracts';

export interface FlowDefinitionDifference {
  path: string;
  before: unknown;
  after: unknown;
}

/** Object-key diff; arrays are shown whole so order changes remain visible. */
export function flowDefinitionDifferences(
  before: DataverseFlowDefinition,
  after: DataverseFlowDefinition
): FlowDefinitionDifference[] {
  const differences: FlowDefinitionDifference[] = [];
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const walk = (left: unknown, right: unknown, path: string) => {
    if (object(left) && object(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(left[key], right[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      }
    } else if (JSON.stringify(left) !== JSON.stringify(right)) {
      differences.push({ path, before: left, after: right });
    }
  };
  walk(
    {
      name: before.name,
      description: before.description,
      clientData: JSON.parse(before.clientData)
    },
    { name: after.name, description: after.description, clientData: JSON.parse(after.clientData) },
    ''
  );
  return differences;
}
