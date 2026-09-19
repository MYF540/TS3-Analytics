import { isRouteErrorResponse, Link, useParams, useRouteError } from 'react-router';
import { t, type MessageKey } from '../i18n';

export function PageHeader({ title, intro }: { title: string; intro: string }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      <p className="muted">{intro}</p>
    </header>
  );
}

function Placeholder({ title, intro }: { title: MessageKey; intro: MessageKey }) {
  return (
    <section>
      <PageHeader title={t(title)} intro={t(intro)} />
      <p className="card">{t('page.placeholder')}</p>
    </section>
  );
}

export function PlayersPage() {
  return <Placeholder title="page.players.title" intro="page.players.intro" />;
}

export function PlayerPage() {
  const { id = '' } = useParams();
  return (
    <section>
      <PageHeader title={t('page.player.title')} intro={t('page.player.intro', { id })} />
      <p className="card">{t('page.placeholder')}</p>
    </section>
  );
}

export function LeaderboardsPage() {
  return <Placeholder title="page.leaderboards.title" intro="page.leaderboards.intro" />;
}

export function NotFoundPage() {
  return (
    <section>
      <PageHeader title={t('page.notFound.title')} intro={t('page.notFound.text')} />
      <Link to="/">{t('page.notFound.back')}</Link>
    </section>
  );
}

/** Shown when a route throws (e.g. a failing loader). */
export function ErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  return (
    <section>
      <PageHeader title={t('error.title')} intro={t('error.UNKNOWN')} />
      <Link to="/">{t('page.notFound.back')}</Link>
    </section>
  );
}
