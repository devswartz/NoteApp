// Routes deep links from the native shells (notivelo://…, universal links) into the app.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api.ts';
import { errorToast } from '../store.ts';
import { parseDeepLink, platform } from '../platform/index.ts';
import { sharedPagePath } from './sharing/sharedPages.ts';

export function DeepLinks() {
  const navigate = useNavigate();
  useEffect(() => {
    const open = async (link: string) => {
      const target = parseDeepLink(link);
      if (!target) return;
      if (target.kind === 'path') return navigate(target.path);
      try {
        const r = await get<{ workspaceId: string }>(`/pages/${encodeURIComponent(target.pageId)}`);
        navigate(sharedPagePath(r.workspaceId, target.pageId)); // its workspace, or the current one for a page shared from outside (#98)
      } catch (e) {
        errorToast(e);
      }
    };
    void platform.deepLinks.initial().then((l) => {
      if (l) void open(l);
    });
    return platform.deepLinks.subscribe((l) => void open(l));
  }, [navigate]);
  return null;
}
