// Emoji picker for page icons (and anything else that wants one).
import { useMemo, useState, type RefObject } from 'react';
import { Popover } from '../components/ui.tsx';

/** A small, curated set with search keywords; no emoji database download. */
const EMOJI: [string, string][] = [
  ['📄', 'page document doc'], ['📝', 'memo note write'], ['📓', 'notebook'], ['📒', 'ledger notebook'], ['📚', 'books library'],
  ['📌', 'pin'], ['📎', 'clip attachment'], ['🗂️', 'folders index'], ['🗓️', 'calendar date'], ['⏰', 'alarm clock time'],
  ['✅', 'done check tick'], ['☑️', 'checkbox'], ['🎯', 'goal target'], ['🚀', 'launch rocket ship'], ['💡', 'idea bulb'],
  ['🔥', 'fire hot'], ['⭐', 'star favourite'], ['❤️', 'heart love'], ['⚠️', 'warning'], ['❗', 'important'],
  ['❓', 'question'], ['🔒', 'lock private secret'], ['🔑', 'key password'], ['🛠️', 'tools build'], ['⚙️', 'settings gear'],
  ['🐛', 'bug'], ['💻', 'computer laptop code'], ['🧪', 'test experiment'], ['📊', 'chart bar stats'], ['📈', 'growth up chart'],
  ['💰', 'money budget'], ['💳', 'card payment'], ['🧾', 'receipt invoice'], ['🏠', 'home house'], ['🏢', 'office work'],
  ['✈️', 'travel plane flight'], ['🌍', 'world globe'], ['🍽️', 'food meal recipe'], ['☕', 'coffee'], ['🏋️', 'gym workout'],
  ['🧘', 'health calm'], ['🎨', 'design art'], ['🎵', 'music'], ['🎬', 'film movie video'], ['📷', 'photo camera'],
  ['🎉', 'party celebrate'], ['🎁', 'gift'], ['👥', 'team people'], ['🤝', 'meeting deal'], ['💬', 'chat discussion'],
  ['📣', 'announce'], ['📧', 'email mail'], ['📞', 'phone call'], ['🧠', 'brain think'], ['📖', 'read book'],
  ['🌱', 'plant growth'], ['🌟', 'sparkle'], ['🧭', 'compass direction'], ['🗺️', 'map roadmap'], ['🏁', 'finish flag'],
];

export function IconPicker({
  anchor,
  open,
  onClose,
  onPick,
  hasIcon,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string | null) => void;
  hasIcon?: boolean;
}) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? EMOJI.filter(([, k]) => k.includes(n)) : EMOJI;
  }, [q]);
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} className="icon-picker">
      <div className="icon-picker-head">
        <input
          className="input"
          autoFocus
          placeholder="Search icons…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list[0]) onPick(list[0][0]);
            // Typing or pasting a single emoji uses it directly.
            if (e.key === 'Enter' && !list[0] && /\p{Extended_Pictographic}/u.test(q)) onPick(q.trim());
          }}
        />
        <button type="button" className="btn-ghost btn-sm" onClick={() => onPick(EMOJI[Math.floor(Math.random() * EMOJI.length)][0])}>
          Random
        </button>
        {hasIcon && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => onPick(null)}>
            Remove
          </button>
        )}
      </div>
      <div className="emoji-grid emoji-grid-lg">
        {list.map(([e, k]) => (
          <button key={e} type="button" className="emoji-btn" title={k.split(' ')[0]} onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
        {!list.length && <span className="muted small">No match. Paste any emoji and press Enter.</span>}
      </div>
    </Popover>
  );
}
