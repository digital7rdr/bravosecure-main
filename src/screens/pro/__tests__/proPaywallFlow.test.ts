import {AxiosError, AxiosHeaders} from 'axios';
import {
  isInsufficientCreditsError,
  outcomeForSubscribeError,
} from '../proPaywallFlow';

function axiosErrWith(message: string): AxiosError {
  const err = new AxiosError('Request failed');
  err.response = {
    data: {message},
    status: 400,
    statusText: 'Bad Request',
    headers: {},
    config: {headers: new AxiosHeaders()},
  };
  return err;
}

describe('proPaywallFlow', () => {
  describe('isInsufficientCreditsError', () => {
    it('detects the insufficient_credits server code', () => {
      expect(isInsufficientCreditsError(axiosErrWith('insufficient_credits'))).toBe(true);
    });
    it('is false for other server codes', () => {
      expect(isInsufficientCreditsError(axiosErrWith('tier_insufficient'))).toBe(false);
    });
    it('is false for a plain Error (e.g. network)', () => {
      expect(isInsufficientCreditsError(new Error('Network Error'))).toBe(false);
    });
  });

  describe('outcomeForSubscribeError', () => {
    it('routes a short balance into the card top-up path', () => {
      expect(outcomeForSubscribeError(axiosErrWith('insufficient_credits')))
        .toEqual({kind: 'topup-then-subscribe'});
    });

    it('keeps the user on Lite for any other failure (payment failed → Lite)', () => {
      const out = outcomeForSubscribeError(new Error('card declined'));
      expect(out.kind).toBe('stay-on-lite');
      expect(out).toMatchObject({reason: 'card declined'});
    });

    it('keeps the user on Lite for a non-credits server error', () => {
      const out = outcomeForSubscribeError(axiosErrWith('user_not_found'));
      expect(out.kind).toBe('stay-on-lite');
    });
  });
});
