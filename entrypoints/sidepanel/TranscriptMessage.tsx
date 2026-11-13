import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StoredTranscriptItem } from '../../lib/conversation-model';
import {
  RecordChangeCards,
  FlowChangeCards,
  ListMembershipCards,
  SkillChangeCards
} from './ApprovalCards';
import { normalizeMarkdown } from './formatting';
import { BulkJobCards } from './BulkJobCards';
import { SchemaChangeCards } from './SchemaChangeCards';
import type { ApprovalActions } from './useApprovals';

export function TranscriptMessage({
  item,
  approvals
}: {
  item: StoredTranscriptItem;
  approvals: ApprovalActions;
}) {
  return (
    <article key={item.id} className={`message ${item.role}`}>
      <span>{item.role === 'assistant' ? 'Oddy' : 'You'}</span>
      <div className={item.role === 'assistant' ? 'markdown-body' : undefined}>
        {item.role === 'assistant' ? (
          <>
            {item.toolsUsed && item.toolsUsed.length > 0 && (
              <div className="tool-activity">
                {item.toolsUsed.map((tool, index) => (
                  <span key={`${tool.name}-${index}`} title={tool.details || tool.label}>
                    <strong>{tool.label}</strong>
                    {tool.summary}
                    {tool.details && <small>{tool.details}</small>}
                  </span>
                ))}
              </div>
            )}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children, ...props }) => (
                  <a {...props} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                )
              }}
            >
              {normalizeMarkdown(item.content)}
            </ReactMarkdown>
            <RecordChangeCards item={item} approvals={approvals} />
            <FlowChangeCards item={item} approvals={approvals} />
            <SchemaChangeCards item={item} approvals={approvals} />
            <ListMembershipCards item={item} approvals={approvals} />
            <SkillChangeCards item={item} approvals={approvals} />
            <BulkJobCards item={item} approvals={approvals} />
          </>
        ) : (
          item.content
        )}
      </div>
    </article>
  );
}
