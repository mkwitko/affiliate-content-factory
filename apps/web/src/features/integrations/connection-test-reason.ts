/** pt-BR labels for the provider-connection test endpoint's failure reasons. */
export const testReasonLabel = (reason: string): string => {
  switch (reason) {
    case "invalid_api_key":
      return "Chave inválida";
    case "account_missing":
      return "Conta não encontrada nesta chave";
    case "reconnect_required":
      return "Reconecte o Mercado Livre";
    case "provider_unavailable":
      return "Serviço indisponível";
    default:
      return "Falha desconhecida";
  }
};

export const formatCheckedAt = (checkedAt: string): string => {
  const date = new Date(checkedAt);
  return Number.isNaN(date.getTime()) ? checkedAt : date.toLocaleTimeString("pt-BR");
};
