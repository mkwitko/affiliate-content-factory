import {
  AcceptInvitationForm,
  createInvitationAcceptanceClient,
} from "../features/onboarding/accept-invitation-form.js";

type InvitationRouteProps = Readonly<{
  token: string;
}>;

export const InvalidInvitationRoute = () => (
  <main className="page-shell" aria-labelledby="invalid-invitation-title">
    <section className="card" aria-live="polite">
      <p className="wordmark">Content Factory</p>
      <h1 id="invalid-invitation-title">Este link de convite é inválido</h1>
      <p>Confira o link ou peça um novo convite a quem administra o espaço.</p>
    </section>
  </main>
);

export const InvitationRoute = ({ token }: InvitationRouteProps) => (
  <AcceptInvitationForm token={token} client={createInvitationAcceptanceClient()} />
);
