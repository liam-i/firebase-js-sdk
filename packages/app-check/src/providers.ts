/**
 * @license
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FirebaseApp, _getProvider } from '@firebase/app';
import { Provider } from '@firebase/component';
import {
  FirebaseError,
  issuedAtTime,
  calculateBackoffMillis
} from '@firebase/util';
import { exchangeToken, getExchangeRecaptchaTokenRequest } from './client';
import { ONE_DAY } from './constants';
import { AppCheckError, ERROR_FACTORY } from './errors';
import { CustomProviderOptions } from './public-types';
import {
  getToken as getReCAPTCHAToken,
  initialize as initializeRecaptcha
} from './recaptcha';
import { AppCheckProvider, AppCheckTokenInternal, ThrottleData } from './types';

/**
 * App Check provider that can obtain a reCAPTCHA V3 token and exchange it
 * for an App Check token.
 *
 * @public
 */
export class ReCaptchaV3Provider implements AppCheckProvider {
  private _app?: FirebaseApp;
  private _platformLoggerProvider?: Provider<'platform-logger'>;
  /**
   * Throttle requests on certain error codes to prevent too many retries
   * in a short time.
   */
  private _throttleData: ThrottleData | null = null;
  /**
   * Create a ReCaptchaV3Provider instance.
   * @param siteKey - ReCAPTCHA V3 siteKey.
   */
  constructor(private _siteKey: string) {}

  /**
   * Returns an App Check token.
   * @internal
   */
  async getToken(): Promise<AppCheckTokenInternal> {
    if (this._throttleData) {
      if (Date.now() - this._throttleData.allowRequestsAfter > 0) {
        // If after throttle timestamp, clear throttle data.
        this._throttleData = null;
      } else {
        // If before, throw.
        throw ERROR_FACTORY.create(AppCheckError.THROTTLED, {
          time: new Date(
            this._throttleData.allowRequestsAfter
          ).toLocaleString(),
          httpStatus: this._throttleData.httpStatus
        });
      }
    }
    if (!this._app || !this._platformLoggerProvider) {
      // This should only occur if user has not called initializeAppCheck().
      // We don't have an appName to provide if so.
      // This should already be caught in the top level `getToken()` function.
      throw ERROR_FACTORY.create(AppCheckError.USE_BEFORE_ACTIVATION, {
        appName: ''
      });
    }
    const attestedClaimsToken = await getReCAPTCHAToken(this._app).catch(_e => {
      // reCaptcha.execute() throws null which is not very descriptive.
      throw ERROR_FACTORY.create(AppCheckError.RECAPTCHA_ERROR);
    });
    let result;
    try {
      result = await exchangeToken(
        getExchangeRecaptchaTokenRequest(this._app, attestedClaimsToken),
        this._platformLoggerProvider
      );
    } catch (e) {
      if ((e as FirebaseError).code === AppCheckError.FETCH_STATUS_ERROR) {
        const throttleData = this._setBackoff(
          Number((e as FirebaseError).customData?.httpStatus)
        );
        throw ERROR_FACTORY.create(AppCheckError.THROTTLED, {
          time: new Date(throttleData.allowRequestsAfter).toLocaleString(),
          httpStatus: throttleData.httpStatus
        });
      } else {
        throw e;
      }
    }
    return result;
  }

  /**
   * Set throttle data to block requests until after a certain time
   * depending on the failed request's status code.
   * @param httpStatus - Status code of failed request.
   * @returns Data about current throttle state and expiration time.
   */
  private _setBackoff(httpStatus: number): ThrottleData {
    /**
     * Block retries for 1 day for the following error codes:
     * 
     * 404: Likely malformed URL.
     * 
     * 403:
     * - Attestation failed
     * - Wrong API key
     * - Project deleted
     */
    if (httpStatus === 404 || httpStatus === 403) {
      this._throttleData = {
        backoffCount: 1,
        allowRequestsAfter: Date.now() + ONE_DAY,
        httpStatus
      };
    } else {
      /**
       * For all other error codes, the time when it is ok to retry again
       * is based on exponential backoff.
       */
      const backoffCount = this._throttleData ? this._throttleData.backoffCount : 0;
      const backoffMillis = calculateBackoffMillis(backoffCount, 1000, 2);
      this._throttleData = {
        backoffCount: backoffCount + 1,
        allowRequestsAfter: Date.now() + backoffMillis,
        httpStatus
      };
    }
    return this._throttleData;
  }

  /**
   * @internal
   */
  initialize(app: FirebaseApp): void {
    this._app = app;
    this._platformLoggerProvider = _getProvider(app, 'platform-logger');
    initializeRecaptcha(app, this._siteKey).catch(() => {
      /* we don't care about the initialization result */
    });
  }

  /**
   * @internal
   */
  isEqual(otherProvider: unknown): boolean {
    if (otherProvider instanceof ReCaptchaV3Provider) {
      return this._siteKey === otherProvider._siteKey;
    } else {
      return false;
    }
  }
}

/**
 * Custom provider class.
 * @public
 */
export class CustomProvider implements AppCheckProvider {
  private _app?: FirebaseApp;

  constructor(private _customProviderOptions: CustomProviderOptions) {}

  /**
   * @internal
   */
  async getToken(): Promise<AppCheckTokenInternal> {
    if (!this._app) {
      // This should only occur if user has not called initializeAppCheck().
      // We don't have an appName to provide if so.
      // This should already be caught in the top level `getToken()` function.
      throw ERROR_FACTORY.create(AppCheckError.USE_BEFORE_ACTIVATION, {
        appName: ''
      });
    }
    // custom provider
    const customToken = await this._customProviderOptions.getToken();
    // Try to extract IAT from custom token, in case this token is not
    // being newly issued. JWT timestamps are in seconds since epoch.
    const issuedAtTimeSeconds = issuedAtTime(customToken.token);
    // Very basic validation, use current timestamp as IAT if JWT
    // has no `iat` field or value is out of bounds.
    const issuedAtTimeMillis =
      issuedAtTimeSeconds !== null &&
      issuedAtTimeSeconds < Date.now() &&
      issuedAtTimeSeconds > 0
        ? issuedAtTimeSeconds * 1000
        : Date.now();

    return { ...customToken, issuedAtTimeMillis };
  }

  /**
   * @internal
   */
  initialize(app: FirebaseApp): void {
    this._app = app;
  }

  /**
   * @internal
   */
  isEqual(otherProvider: unknown): boolean {
    if (otherProvider instanceof CustomProvider) {
      return (
        this._customProviderOptions.getToken.toString() ===
        otherProvider._customProviderOptions.getToken.toString()
      );
    } else {
      return false;
    }
  }
}
