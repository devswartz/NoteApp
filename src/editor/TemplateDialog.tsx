// "Save as template" and "Available in…" for a user template: a name (when saving) and the sections
// it's offered in. No sections ticked = offered everywhere (template_sections, migration 016).
//   const r = await templateDialog({ title: 'Save page as template', name: 'Weekly', confirmLabel: 'Save template' });
// <TemplateDialogHost /> is mounted once in PageView (where both entry points live).
import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { useStore } from '../store.ts';
import { Button, Dialog, Input } from '../components/ui.tsx';
import { byPos } from '../components/shell/treeDnd.ts';
import { sectionsInOrder } from '../../shared/sections.ts';
import type { TemplateMeta } from '../../shared/types.ts';

type Scope = TemplateMeta['sections'];
interface Opts {
  title: string;
  message?: ReactNode;
  /** Ask for a name too, starting with this value. */
  name?: string;
  sections?: Scope;
  confirmLabel: string;
}
export interface TemplateDialogResult {
  name: string;
  sections: Scope;
}

const useTemplateDialog = create<{ current: { opts: Opts; resolve: (v: TemplateDialogResult | null) => void } | null }>(() => ({ current: null }));

export function templateDialog(opts: Opts): Promise<TemplateDialogResult | null> {
  return new Promise((resolve) => {
    useTemplateDialog.getState().current?.resolve(null);
    useTemplateDialog.setState({ current: { opts, resolve } });
  });
}

export function TemplateDialogHost() {
  const current = useTemplateDialog((s) => s.current);
  const tree = useStore((s) => s.tree);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Map<string, boolean>>(new Map());
  useEffect(() => {
    if (!current) return;
    setName(current.opts.name ?? '');
    setPicked(new Map((current.opts.sections ?? []).map((s) => [s.sectionId, s.includeSubsections])));
  }, [current]);
  if (!current) return null;
  const o = current.opts;
  const askName = o.name !== undefined;

  const finish = (ok: boolean) => {
    useTemplateDialog.setState({ current: null });
    current.resolve(ok ? { name: name.trim(), sections: [...picked].map(([sectionId, includeSubsections]) => ({ sectionId, includeSubsections })) } : null);
  };
  const toggle = (id: string, on: boolean) => {
    const next = new Map(picked);
    if (on) next.set(id, true);
    else next.delete(id);
    setPicked(next);
  };
  const hasKids = (id: string) => tree.sections.some((s) => s.parentId === id);

  return (
    <Dialog open size="sm" onClose={() => finish(false)} title={o.title} description={o.message}>
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        {askName && <Input label="Template name" value={name} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.currentTarget.select()} />}
        <fieldset className="tpl-scope">
          <legend className="field-label">Available in</legend>
          <p className="muted small">{picked.size ? `Offered first in ${picked.size === 1 ? 'this section' : `these ${picked.size} sections`}, and not elsewhere.` : 'Every section. Tick sections to offer it only there.'}</p>
          <div className="tpl-scope-list" role="group" aria-label="Sections">
            {[...tree.notebooks].sort(byPos).map((nb) => {
              const secs = sectionsInOrder(tree, nb.id);
              if (!secs.length) return null;
              return (
                <div key={nb.id}>
                  <div className="move-group-title">{nb.name}</div>
                  {secs.map(({ section: s, level }) => (
                    <div key={s.id} className="tpl-scope-row" style={{ paddingLeft: (level - 1) * 18 }}>
                      <label className="row gap-6 grow">
                        <input type="checkbox" checked={picked.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} />
                        <span className="sec-tab" style={{ background: s.color }} />
                        <span className="truncate">{s.name}</span>
                      </label>
                      {picked.has(s.id) && hasKids(s.id) && (
                        <label className="row gap-6 small muted">
                          <input
                            type="checkbox"
                            checked={picked.get(s.id)}
                            onChange={(e) => setPicked(new Map(picked).set(s.id, e.target.checked))}
                            aria-label={`Also in subsections of ${s.name}`}
                          />
                          Subsections
                        </label>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </fieldset>
        <div className="dialog-foot flush">
          <Button variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={askName && !name.trim()}>
            {o.confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
