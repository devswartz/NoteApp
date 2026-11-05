// Routes deep links from the native shells (noteapp://…, universal links) into the app.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api.ts';
import { errorToast } from '../store.ts';
import { parseDeepLink, platform } from '../platform/index.ts';

export function DeepLinks() {
  const navigate = useNavigate();
  useEffect(() => {
    const open = async (link: string) => {
      const target = parseDeepLink(link);
      if (!target) return;
      if (target.kind === 'path') return navigate(target.path);
      try {
        const r = await get<{ workspaceId: string }>(`/pages/${encodeURIComponent(target.pageId)}`);
        navigate(`/w/${r.workspaceId}/p/${target.pageId}`);
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
