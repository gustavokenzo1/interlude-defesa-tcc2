import { attachDeadline, remainingMilliseconds } from '../runtime/deadline.js';
import axios, { type AxiosInstance } from 'axios';
import { GoogleAuth, type IdTokenClient } from 'google-auth-library';
import type { SolverPayload, SolverPort, SolverResponse } from '../../domain/ports.js';

export class HttpSolverClient implements SolverPort {
  private readonly client: AxiosInstance;
  private readonly idTokenClient?: Promise<IdTokenClient>;

  constructor(baseUrl: string, idTokenAudience?: string) {
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 60_000,
    });
    attachDeadline(this.client);
    if (idTokenAudience) {
      this.idTokenClient = new GoogleAuth().getIdTokenClient(idTokenAudience);
    }
  }

  async solve(payload: SolverPayload): Promise<SolverResponse> {
    const requestHeaders = this.idTokenClient
      ? await (await this.idTokenClient).getRequestHeaders()
      : undefined;
    const authorization = requestHeaders?.get('authorization') ?? undefined;
    const budget = Math.min(55, Math.floor(remainingMilliseconds() / 1000) - 2);
    if (budget < 1) throw new Error('O prazo de geração terminou. Reduza a quantidade de etapas e tente novamente.');
    const { data } = await this.client.post<SolverResponse>('/solve', { ...payload, max_compute_seconds: budget }, {
      headers: authorization ? { Authorization: authorization } : undefined,
    });
    return data;
  }
}
