import { useEffect, useState } from 'react';
import { Bell, BellRing } from 'lucide-react';
import { fetchFollowing, saveFollowing } from '../../api/home-api';
import { useHostUi } from '../../host/host-ui';

/**
 * Follow one App page (RFC 0010, HH-16). Followed pages lead "What moved" on
 * Home. With a host, following is kept by the host, which tells the person
 * about each new edition the way their notification settings say; without
 * one it is this person's own state in the project's private folder.
 */
export function FollowPageButton({ appId, pageId }: { appId: string; pageId: string }): JSX.Element | null {
  const host = useHostUi().host;
  const [following, setFollowing] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFollowing(null);
    setError(null);
    void fetchFollowing(appId, pageId).then((value) => { if (!cancelled) setFollowing(value); });
    return () => { cancelled = true; };
  }, [appId, pageId]);
  // The server could not say: no button rather than a wrong one.
  if (following === null) return null;
  const toggle = async () => {
    setBusy(true);
    setError(null);
    const result = await saveFollowing(appId, pageId, !following);
    setBusy(false);
    if (result.ok) setFollowing(result.following);
    else setError(result.refusal.error);
  };
  const title = following
    ? 'Following — this page leads What moved on your Home. Click to stop following.'
    : host
      ? 'Follow this page: it leads What moved on your Home, and you hear about each new edition the way your notification settings say.'
      : 'Follow this page: it leads What moved on your Home.';
  return (
    <>
      <button
        type="button"
        className={`dql-apps-btn dql-apps-btn-line ${following ? 'on' : ''}`}
        aria-pressed={following}
        disabled={busy}
        title={title}
        onClick={() => void toggle()}
      >
        {following ? <BellRing size={14} /> : <Bell size={14} />} {following ? 'Following' : 'Follow'}
      </button>
      {error ? <div className="dql-app-promote-popover error" role="alert">{error}</div> : null}
    </>
  );
}
