import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { t } from '../i18n';

export function PageHeader({ title, intro }: { title: string; intro: string }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      <p className="muted">{intro}</p>
    </header>
  );
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
