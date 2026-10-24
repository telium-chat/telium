import { useEffect, useState } from 'react';
import { Table } from '@cloudflare/kumo/components/table';
import { cn } from '../lib/cn.js';
import { EmptyState } from './Feedback.jsx';
import { checkIsMobile } from '../lib/platform.js';
import { useT } from '../lib/i18n/react.jsx';

function partition(columns, row) {
  const cells = columns.map((col) => ({ col, value: col.render(row) }));
  const [primary, ...rest] = cells;
  const kept = rest.filter(({ value }) => (
    value !== null && value !== undefined && value !== false && value !== ''
  ));
  return {
    primary,
    details: kept.filter(({ col }) => Boolean(col.header)),
    actions: kept.filter(({ col }) => !col.header),
  };
}

function RecordList({ columns, rows, rowKey, label }) {
  return (
    <div role="list" aria-label={label} className="record-list">
      {rows.map((row, i) => {
        const { primary, details, actions } = partition(columns, row);
        return (
          <div role="listitem" key={rowKey ? rowKey(row) : i} className="record">
            <div className="record__body">
              {primary ? (
                <div className={cn('record__name', primary.col.mono && 'font-mono')}>
                  {primary.value}
                </div>
              ) : null}
              {details.length ? (
                <div className="record__meta">
                  {details.map(({ col, value }) => (
                    <span key={col.key} className="record__fact">
                      <span className="record__label">{col.header}</span>
                      <span className={cn('record__value', col.mono && 'font-mono')}>{value}</span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            {actions.length ? (
              <div className="record__actions">
                {actions.map(({ col, value }) => (
                  <span key={col.key} className="flex items-center">{value}</span>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function DataTable({
  columns, rows, rowKey, empty, label, layout = 'table',
}) {
  const t = useT();
  const emptyText = empty ?? t('common.table.empty');
  const labelText = label ?? t('common.table.label');
  const [mobile, setMobile] = useState(() => checkIsMobile());

  useEffect(() => {
    const resize = () => setMobile(checkIsMobile());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  if (!rows.length) return <EmptyState>{emptyText}</EmptyState>;

  if (layout === 'rows') {
    return <RecordList columns={columns} rows={rows} rowKey={rowKey} label={labelText} />;
  }

  if (mobile) {
    return (
      <div role="list" aria-label={labelText} className="flex flex-col gap-2">
        {rows.map((row, i) => {
          const key = rowKey ? rowKey(row) : i;
          const { primary, details, actions } = partition(columns, row);

          return (
            <article
              key={key}
              role="listitem"
              className="rounded-card bg-surface-secondary p-3"
            >
              {primary ? (
                <div className={cn(
                  'min-w-0 break-words text-base font-semibold text-foreground',
                  primary.col.mono && 'font-mono text-sm',
                )}>
                  {primary.value}
                </div>
              ) : null}

              {details.length ? (
                <dl className="mt-2 flex flex-col gap-2 border-t border-separator pt-2">
                  {details.map(({ col, value }) => (
                    <div
                      key={col.key}
                      className="grid min-w-0 grid-cols-[minmax(82px,0.38fr)_minmax(0,1fr)] gap-3"
                    >
                      <dt className="text-2xs font-medium uppercase tracking-wider text-muted">
                        {col.header}
                      </dt>
                      <dd className={cn(
                        'min-w-0 break-words text-end text-sm text-foreground',
                        col.mono && 'font-mono text-xs',
                      )}>
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {actions.length ? (
                <div className="mt-3 flex min-h-11 flex-wrap items-center justify-end gap-2 border-t border-separator pt-2">
                  {actions.map(({ col, value }) => (
                    <div key={col.key} className="flex items-center">{value}</div>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-card bg-surface-secondary">
      <Table aria-label={labelText} className="data-table">
        <Table.Header variant="compact">
          <Table.Row>
            {columns.map((col) => (
              <Table.Head
                key={col.key}
                scope="col"
                sticky={col.sticky}
                className={cn(col.align === 'end' && 'text-end', col.width, col.className)}
              >
                {col.header}
              </Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((row, i) => (
            <Table.Row key={rowKey ? rowKey(row) : i}>
              {columns.map((col) => (
                <Table.Cell
                  key={col.key}
                  role={col.key === columns[0]?.key ? 'rowheader' : undefined}
                  sticky={col.sticky}
                  className={cn(
                    col.align === 'end' && 'text-end',
                    col.mono && 'font-mono text-xs',
                    col.className,
                  )}
                >
                  {col.render(row)}
                </Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}
