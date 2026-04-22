import moment, { type Moment } from 'moment';
import { type Page } from 'puppeteer';
import { SHEKEL_CURRENCY } from '../constants';
import {
  clickButton,
  elementPresentOnPage,
  pageEvalAll,
  waitUntilElementDisappear,
  waitUntilElementFound,
} from '../helpers/elements-interactions';
import { waitForNavigation } from '../helpers/navigation';
import { getRawTransaction } from '../helpers/transactions';
import { TransactionStatuses, TransactionTypes, type Transaction, type TransactionsAccount } from '../transactions';
import { BaseScraperWithBrowser, LoginResults, type PossibleLoginResults } from './base-scraper-with-browser';
import { type ScraperOptions } from './interface';

const LOGIN_URL = 'https://login.yahav.co.il/login/';
const BASE_URL = 'https://digital.yahav.co.il/BaNCSDigitalUI/app/index.html#/';
const INVALID_DETAILS_SELECTOR = '.ui-dialog-buttons';
const CHANGE_PASSWORD_OLD_PASS = 'input#ef_req_parameter_old_credential';
const BASE_WELCOME_URL = `${BASE_URL}main/home`;

const ACCOUNT_ID_SELECTOR_SINGLE = 'span.portfolio-value';
const ACCOUNT_ID_SELECTOR_MULTI = 'form[name="formPortfolioSelect"] .selected-item-top';
const ACCOUNT_DETAILS_SELECTOR = '.account-details';
const DATE_FORMAT = 'DD/MM/YYYY';

const USER_ELEM = '#username';
const PASSWD_ELEM = '#password';
const NATIONALID_ELEM = '#pinno';
const SUBMIT_LOGIN_SELECTOR = '.btn';

interface ScrapedTransaction {
  credit: string;
  debit: string;
  date: string;
  reference?: string;
  description: string;
  memo: string;
  status: TransactionStatuses;
}

function getPossibleLoginResults(page: Page): PossibleLoginResults {
  // checkout file `base-scraper-with-browser.ts` for available result types
  const urls: PossibleLoginResults = {};
  urls[LoginResults.Success] = [`${BASE_WELCOME_URL}`];
  urls[LoginResults.InvalidPassword] = [
    async () => {
      return elementPresentOnPage(page, `${INVALID_DETAILS_SELECTOR}`);
    },
  ];

  urls[LoginResults.ChangePassword] = [
    async () => {
      return elementPresentOnPage(page, `${CHANGE_PASSWORD_OLD_PASS}`);
    },
  ];

  return urls;
}

async function getAccountID(page: Page): Promise<string> {
  // Wait for whichever selector appears first — single-portfolio vs multi-portfolio accounts
  await Promise.any([
    page.waitForSelector(ACCOUNT_ID_SELECTOR_SINGLE, { timeout: 10000 }),
    page.waitForSelector(ACCOUNT_ID_SELECTOR_MULTI, { timeout: 10000 }),
  ]).catch(() => null);

  const selector = (await page.$(ACCOUNT_ID_SELECTOR_SINGLE)) ? ACCOUNT_ID_SELECTOR_SINGLE : ACCOUNT_ID_SELECTOR_MULTI;

  try {
    const text = await page.$eval(selector, (element: Element) => element.textContent ?? '');
    return text.trim();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve account ID. Possible outdated selector '${selector}': ${errorMessage}`);
  }
}

function getAmountData(amountStr: string) {
  const amountStrCopy = amountStr.replace(',', '');
  return parseFloat(amountStrCopy);
}

function getTxnAmount(txn: ScrapedTransaction) {
  const credit = getAmountData(txn.credit);
  const debit = getAmountData(txn.debit);
  return (Number.isNaN(credit) ? 0 : credit) - (Number.isNaN(debit) ? 0 : debit);
}

type TransactionsTr = { id: string; innerDivs: string[] };

function convertTransactions(txns: ScrapedTransaction[], options?: ScraperOptions): Transaction[] {
  return txns.map(txn => {
    const convertedDate = moment(txn.date, DATE_FORMAT).toISOString();
    const convertedAmount = getTxnAmount(txn);
    const result: Transaction = {
      type: TransactionTypes.Normal,
      identifier: txn.reference ? parseInt(txn.reference, 10) : undefined,
      date: convertedDate,
      processedDate: convertedDate,
      originalAmount: convertedAmount,
      originalCurrency: SHEKEL_CURRENCY,
      chargedAmount: convertedAmount,
      status: txn.status,
      description: txn.description,
      memo: txn.memo,
    };

    if (options?.includeRawTransaction) {
      result.rawTransaction = getRawTransaction(txn);
    }

    return result;
  });
}

function handleTransactionRow(txns: ScrapedTransaction[], txnRow: TransactionsTr) {
  const div = txnRow.innerDivs;

  // Remove anything except digits.
  const regex = /\D+/gm;

  const tx: ScrapedTransaction = {
    date: div[1],
    reference: div[2].replace(regex, ''),
    memo: '',
    description: div[3],
    debit: div[4],
    credit: div[5],
    status: TransactionStatuses.Completed,
  };

  txns.push(tx);
}

async function getAccountTransactions(page: Page, options?: ScraperOptions): Promise<Transaction[]> {
  // Wait for transactions.
  await waitUntilElementFound(page, '.under-line-txn-table-header', true);

  const txns: ScrapedTransaction[] = [];
  const transactionsDivs = await pageEvalAll<TransactionsTr[]>(
    page,
    '.list-item-holder .entire-content-ctr',
    [],
    divs => {
      return (divs as HTMLElement[]).map(div => ({
        id: div.getAttribute('id') || '',
        innerDivs: Array.from(div.getElementsByTagName('div')).map(el => (el as HTMLElement).innerText),
      }));
    },
  );

  for (const txnRow of transactionsDivs) {
    handleTransactionRow(txns, txnRow);
  }

  return convertTransactions(txns, options);
}

// All datepicker selectors are scoped to the "from date" control to avoid ambiguity with the "to date" picker.
const FROM_PICKER = 'date-picker-access[btn-label="from"]';

// Manipulate the calendar drop down to choose the txs start date.
async function searchByDates(page: Page, startDate: Moment) {
  // Open the "from date" calendar picker
  await waitUntilElementFound(page, `${FROM_PICKER} a.datepicker-button`, true);
  await clickButton(page, `${FROM_PICKER} a.datepicker-button`);

  // Wait for the calendar popup to appear
  await waitUntilElementFound(page, `${FROM_PICKER} .datepicker-calendar`, true);

  // Read the input value (set by ng-value/textToDateFilter, always DD/MM/YYYY) to determine which
  // month the calendar opened on — avoids parsing the header text which renders in the account's locale.
  const inputValue = await page.$eval(`${FROM_PICKER} .date-picker-input`, el => (el as HTMLInputElement).value);
  const displayedMoment = moment(inputValue, 'DD/MM/YYYY');
  const monthsToGoBack =
    (displayedMoment.year() - startDate.year()) * 12 + (displayedMoment.month() - startDate.month());
  for (let i = 0; i < monthsToGoBack; i += 1) {
    const prevMonthSelector = `${FROM_PICKER} .datepicker-month-prev.enabled`;
    await waitUntilElementFound(page, prevMonthSelector, true);
    await clickButton(page, prevMonthSelector);
  }

  // Click the target day — scoped to current-month cells to avoid adjacent-month cells with the same day number
  const daySelector = `${FROM_PICKER} .datepicker-calendar td.day.selectable:not(.other-month)[data-value="${startDate.date()}"]`;
  await waitUntilElementFound(page, daySelector, true);
  await clickButton(page, daySelector);
}

async function fetchAccountData(
  page: Page,
  startDate: Moment,
  accountID: string,
  options?: ScraperOptions,
): Promise<TransactionsAccount> {
  await waitUntilElementDisappear(page, '.loading-bar-spinner');
  await searchByDates(page, startDate);
  await waitUntilElementDisappear(page, '.loading-bar-spinner');
  const txns = await getAccountTransactions(page, options);

  return {
    accountNumber: accountID,
    txns,
  };
}

async function fetchAccounts(page: Page, startDate: Moment, options?: ScraperOptions): Promise<TransactionsAccount[]> {
  const accounts: TransactionsAccount[] = [];

  // TODO: only the currently selected portfolio is scraped. For multi-portfolio accounts,
  // this should iterate over the options in form[name="formPortfolioSelect"], select each one,
  // and call fetchAccountData for each. The data model supports it — ScraperScrapingResult
  // returns TransactionsAccount[], each with its own accountNumber and txns[].
  const accountID = await getAccountID(page);
  const accountData = await fetchAccountData(page, startDate, accountID, options);
  accounts.push(accountData);

  return accounts;
}

async function waitReadinessForAll(page: Page) {
  await waitUntilElementFound(page, `${USER_ELEM}`, true);
  await waitUntilElementFound(page, `${PASSWD_ELEM}`, true);
  await waitUntilElementFound(page, `${NATIONALID_ELEM}`, true);
  await waitUntilElementFound(page, `${SUBMIT_LOGIN_SELECTOR}`, true);
}

async function redirectOrDialog(page: Page) {
  // Click on bank messages if any.
  await waitForNavigation(page);
  await waitUntilElementDisappear(page, '.loading-bar-spinner');
  const hasMessage = await elementPresentOnPage(page, '.messaging-links-container');
  if (hasMessage) {
    await clickButton(page, '.link-1');
  }

  const promise1 = page.waitForSelector(ACCOUNT_DETAILS_SELECTOR, { timeout: 30000 });
  const promise2 = page.waitForSelector(CHANGE_PASSWORD_OLD_PASS, { timeout: 30000 });
  const promises = [promise1, promise2];

  await Promise.race(promises);
  await waitUntilElementDisappear(page, '.loading-bar-spinner');
}

type ScraperSpecificCredentials = { username: string; password: string; nationalID: string };

class YahavScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  getLoginOptions(credentials: ScraperSpecificCredentials) {
    return {
      loginUrl: `${LOGIN_URL}`,
      fields: [
        { selector: `${USER_ELEM}`, value: credentials.username },
        { selector: `${PASSWD_ELEM}`, value: credentials.password },
        { selector: `${NATIONALID_ELEM}`, value: credentials.nationalID },
      ],
      submitButtonSelector: `${SUBMIT_LOGIN_SELECTOR}`,
      checkReadiness: async () => waitReadinessForAll(this.page),
      postAction: async () => redirectOrDialog(this.page),
      possibleResults: getPossibleLoginResults(this.page),
    };
  }

  async fetchData() {
    // Goto statements page
    await waitUntilElementFound(this.page, ACCOUNT_DETAILS_SELECTOR, true);
    await clickButton(this.page, ACCOUNT_DETAILS_SELECTOR);
    await waitUntilElementFound(this.page, '.statement-options .selected-item-top', true);

    const defaultStartMoment = moment().subtract(3, 'months').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment.min(moment.max(defaultStartMoment, moment(startDate)), moment());

    const accounts = await fetchAccounts(this.page, startMoment, this.options);

    return {
      success: true,
      accounts,
    };
  }
}

export default YahavScraper;
