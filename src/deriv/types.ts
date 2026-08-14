export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  epoch: number;
}

export interface DerivError {
  code?: string;
  message: string;
}

export interface DerivResponse {
  msg_type: string;
  req_id?: number;
  error?: DerivError;
  [key: string]: unknown;
}

export interface AuthorizeResult {
  loginid: string;
  is_virtual: 0 | 1;
  currency: string;
  balance: number;
  email?: string;
  landing_company_name?: string;
}

export interface ActiveSymbol {
  symbol: string;
  display_name: string;
  market: string;
  submarket: string;
  exchange_is_open: 0 | 1;
  is_trading_suspended: 0 | 1;
}

export interface ProposalResult {
  id: string;
  ask_price: number;
  payout: number;
  spot: number;
  spot_time: number;
  display_value: string;
  longcode: string;
}

export interface BuyResult {
  contract_id: number;
  transaction_id: number;
  buy_price: number;
  payout: number;
  purchase_time: number;
  longcode: string;
  start_time: number;
}

export interface OpenContract {
  contract_id: number;
  status?: string;
  is_sold?: 0 | 1;
  profit?: number;
  buy_price?: number;
  payout?: number;
  underlying?: string;
  contract_type?: string;
  entry_spot?: number;
  current_spot?: number;
  sell_price?: number;
}

export type Direction = 'CALL' | 'PUT';
