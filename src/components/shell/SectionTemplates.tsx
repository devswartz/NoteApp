// Section templates in the shell: "New page from template ▸" (the section's ⋯ menu and the ribbon's
// New page), "Default template…" (the section's ⋯ menu), and the small template icon on sections
// whose new pages start from a default (src/editor/defaultTemplates.ts).
import { useEffect } from 'react';
import { ChevronLeft, FileText, LayoutTemplate } from 'lucide-react';
import { MenuItem, MenuLabel, MenuSeparator } from '../ui.tsx';
import { errorToast, toast, useStore } from '../../store.ts';
import { ensureUserTemplates, useUserTemplates } from '../../editor/userTemplates.ts';
import { setSectionDefaultTemplate } from '../../editor/defaultTemplates.ts';
import { effectiveDefaultTemplate, templateOffer } from '../../../shared/sections.ts';
import type { TemplateMeta } from '../../../shared/types.ts';

const NONE: TemplateMeta[] = [];

/** The templates offered in `sectionId`: those tied to it (or a parent) first, then those offered everywhere. */
export function useSectionTemplates(sectionId: string | null | undefined): TemplateMeta[] {
  const wsId = useStore((s) => s.wsId);
  const tree = useStore((s) => s.tree);
  const items = useUserTemplates((s) => (s.wsId === wsId ? s.items : NONE));
  useEffect(() => ensureUserTemplates(wsId), [wsId]);
  if (!sectionId) return NONE;
  const tied = items.filter((t) => templateOffer(t, sectionId, tree) === 'section');
  const everywhere = items.filter((t) => templateOffer(t, sectionId, tree) === 'everywhere');
  return [...tied, ...everywhere];
}

/** The section's effective default template (its own or inherited), with where it comes from. */
export function useSectionDefault(sectionId: string | null | undefined): { template: TemplateMeta; inheritedFrom: string | null } | null {
  const wsId = useStore((s) => s.wsId);
  const tree = useStore((s) => s.tree);
  const items = useUserTemplates((s) => (s.wsId === wsId ? s.items : NONE));
  const d = effectiveDefaultTemplate(tree, sectionId);
  const wanted = d?.templateId;
  useEffect(() => {
    if (wanted) ensureUserTemplates(wsId);
  }, [wanted, wsId]);
  if (!d) return null;
  const template = items.find((t) => t.id === d.templateId);
  if (!template) return null;
  return { template, inheritedFrom: d.from === sectionId ? null : (tree.sections.find((s) => s.id === d.from)?.name ?? null) };
}

/** Menu rows: the section's templates (its default first, marked) and Blank page. `pick(null)` = blank. */
export function NewFromTemplateItems({ sectionId, pick }: { sectionId: string; pick: (templateId: string | null) => void }) {
  const list = useSectionTemplates(sectionId);
  const def = useSectionDefault(sectionId);
  const ordered = def ? [def.template, ...list.filter((t) => t.id !== def.template.id)] : list;
  return (
    <>
      {ordered.map((t) => (
        <MenuItem key={t.id} icon={<span aria-hidden>{t.icon || '📋'}</span>} onSelect={() => pick(t.id)} hint={def?.template.id === t.id ? 'Default' : undefined}>
          {t.name}
        </MenuItem>
      ))}
      {!ordered.length && <MenuLabel>No templates for this section yet. Use “Save as template” in a page’s menu.</MenuLabel>}
      <MenuSeparator />
      <MenuItem icon={<FileText size={15} />} onSelect={() => pick(null)}>
        Blank page
      </MenuItem>
    </>
  );
}

/** "Default template…" rows: inherit / None / each workspace template offered in the section. */
export function DefaultTemplateItems({ sectionId, onBack }: { sectionId: string; onBack: () => void }) {
  const tree = useStore((s) => s.tree);
  const section = tree.sections.find((s) => s.id === sectionId);
  const parent = section?.parentId ? tree.sections.find((s) => s.id === section.parentId) : undefined;
  const list = useSectionTemplates(sectionId);
  const inherited = useSectionDefault(parent?.id);
  if (!section) return null;
  const own = section.defaultTemplateId ?? null;
  const set = (v: string | 'none' | null, label: string) =>
    setSectionDefaultTemplate(sectionId, v)
      .then(() => toast(label))
      .catch(errorToast);
  return (
    <>
      <MenuItem icon={<ChevronLeft size={15} />} onSelect={onBack} keepOpen>
        Default template
      </MenuItem>
      <MenuSeparator />
      {parent && (
        <MenuItem onSelect={() => void set(null, 'Default template cleared')} checked={!own && !section.noDefaultTemplate}>
          {inherited ? `Same as ${parent.name} (${inherited.template.name})` : `Same as ${parent.name} (none)`}
        </MenuItem>
      )}
      <MenuItem onSelect={() => void set(parent ? 'none' : null, 'New pages here start blank')} checked={parent ? !!section.noDefaultTemplate && !own : !own}>
        None
      </MenuItem>
      {list.length > 0 && <MenuSeparator />}
      {list.map((t) =>
        t.visibility === 'private' ? (
          <MenuLabel key={t.id}>
            {t.icon || '📋'} {t.name} · only you can see it, so it can’t be a default
          </MenuLabel>
        ) : (
          <MenuItem key={t.id} icon={<span aria-hidden>{t.icon || '📋'}</span>} checked={own === t.id} onSelect={() => void set(t.id, `New pages in ${section.name} start from ${t.name}`)}>
            {t.name}
          </MenuItem>
        ),
      )}
      {!list.length && <MenuLabel>No templates for this section yet. Use “Save as template” in a page’s menu.</MenuLabel>}
    </>
  );
}

/** The small icon on a section whose new pages start from a template. */
export function SectionDefaultBadge({ sectionId }: { sectionId: string }) {
  const def = useSectionDefault(sectionId);
  if (!def) return null;
  const tip = `New pages start from “${def.template.name}”${def.inheritedFrom ? ` (set on ${def.inheritedFrom})` : ''}`;
  return (
    <span className="sec-default-tpl subtle" title={tip} aria-label={tip} role="img" data-testid="section-default-template">
      <LayoutTemplate size={12} aria-hidden />
    </span>
  );
}
