import {
	IExecuteFunctions,
	INodeType,
	INodeTypeDescription,
	INodeExecutionData,
	NodeOperationError,
	IHttpRequestOptions,
	IHttpRequestMethods,
	IDataObject,
	NodeApiError,
	IWebhookFunctions,
	// Removed: BinaryHelperFunctions, RequestHelperFunctions
	NodeExecutionWithMetadata,
	INode,
	IWebhookResponseData,
	// Removed: IBinaryKeyData, IPairedItemData, GenericValue
	IAllExecuteFunctions, // Import for helper 'this' context if needed
} from 'n8n-workflow';

import { v4 as uuidv4 } from 'uuid';
import * as objectPath from 'object-path';

// --- Interfaces --- (Keep existing interfaces: IWebhookConfig, IWebhookListener, IWebhookRequestObject)

interface IWebhookConfig {
	webhookMethod?: 'POST' | 'GET' | 'PUT';
	correlationIdLocationInRequest?: 'query' | 'header' | 'bodyJsonPath' | 'none';
	correlationIdParameterName?: string;
	callbackUrlParameterNameInRequest?: string;
	callbackUrlLocationInRequest?: 'query' | 'header' | 'bodyJsonPath';
	correlationIdLocationInWebhook?: 'query' | 'header' | 'bodyJsonPath';
	correlationIdParameterNameInWebhook?: string;
	timeoutWebhook?: number;
	webhookResponseIncludes?: Array<'body' | 'headers' | 'query'>;
}

interface IWebhookListener {
	resolve: (data: IDataObject) => void;
	reject: (reason?: any) => void;
	timeoutTimer: NodeJS.Timeout;
	expectedMethod: string;
	correlationId: string;
	webhookConfig: IWebhookConfig;
	itemIndex: number;
}

interface IWebhookRequestObject {
	headers: IDataObject;
	params: IDataObject;
	query: IDataObject;
	body: IDataObject | string | unknown;
	method?: string;
	path?: string;
}

// --- Type Guard ---
function isNodeApiError(error: any): error is NodeApiError {
	return error instanceof NodeApiError && typeof error.context === 'object';
}


// --- Node Class ---
export class AsyncHttpRequest implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Async HTTP Request',
		name: 'asyncHttpRequest',
		icon: 'fa:exchange-alt',
		group: ['helpers'],
		version: 1,
		description: 'Sends HTTP request, waits for async webhook response.',
		defaults: {
			name: 'Async HTTP Request',
		},
		// inputs: ['main'], // Defaults to main
		// outputs: ['main'], // Defaults to main
		credentials: [
			// Credentials remain the same
			{
				name: 'httpBasicAuth',
				required: false,
				displayOptions: { show: { authentication: ['basicAuth'] } },
			},
			{
				name: 'httpDigestAuth',
				required: false,
				displayOptions: { show: { authentication: ['digestAuth'] } },
			},
			{
				name: 'httpHeaderAuth',
				required: false,
				displayOptions: { show: { authentication: ['headerAuth'] } },
			},
			{
				name: 'httpOAuth1Api',
				required: false,
				displayOptions: { show: { authentication: ['oAuth1'] } },
			},
			{
				name: 'httpOAuth2Api',
				required: false,
				displayOptions: { show: { authentication: ['oAuth2'] } },
			},
			{
				name: 'queryAuthApi',
				required: false,
				displayOptions: { show: { authentication: ['queryAuth'] } },
			},
		],
		properties: [
			// Properties remain the same
			// URL
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'http://example.com/resource',
				description: 'The URL to send the request to',
			},
			// Method
			{
				displayName: 'Method',
				name: 'method',
				type: 'options',
				options: [
					{ name: 'DELETE', value: 'DELETE' },
					{ name: 'GET', value: 'GET' },
					{ name: 'HEAD', value: 'HEAD' },
					{ name: 'OPTIONS', value: 'OPTIONS' },
					{ name: 'PATCH', value: 'PATCH' },
					{ name: 'POST', value: 'POST' },
					{ name: 'PUT', value: 'PUT' },
				],
				required: true,
				default: 'GET',
				description: 'The HTTP method to use for the request',
			},
			// Authentication
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				options: [
					{ name: 'None', value: 'none' },
					{ name: 'Basic Auth', value: 'basicAuth' },
					{ name: 'Digest Auth', value: 'digestAuth' },
					{ name: 'Header Auth', value: 'headerAuth' },
					{ name: 'OAuth1', value: 'oAuth1' },
					{ name: 'OAuth2', value: 'oAuth2' },
					{ name: 'Query Auth', value: 'queryAuth' },
				],
				default: 'none',
				description: 'The authentication method to use',
			},
			// Send Body Toggle
			{
				displayName: 'Send Body',
				name: 'sendBody',
				type: 'boolean',
				default: false,
				description: 'Whether to send a body with the request',
				displayOptions: { show: { method: ['PATCH', 'POST', 'PUT'] } },
			},
			// Body Content Type
			{
				displayName: 'Body Content Type',
				name: 'contentType',
				type: 'options',
				displayOptions: { show: { sendBody: [true], method: ['PATCH', 'POST', 'PUT'] } },
				options: [
					{ name: 'Form-Data Multipart', value: 'multipart-form-data' },
					{ name: 'Form-URL-Encoded', value: 'form-urlencoded' },
					{ name: 'JSON', value: 'json' },
					{ name: 'Raw', value: 'raw' },
					{ name: 'N/A', value: 'none' },
				],
				required: true,
				default: 'json',
				description: 'The Content-Type to send with the request body',
			},
			// Raw Content Type
			{
				displayName: 'Raw Content Type',
				name: 'rawContentType',
				type: 'string',
				default: 'text/plain',
				required: true,
				displayOptions: {
					show: {
						sendBody: [true],
						contentType: ['raw'],
						method: ['PATCH', 'POST', 'PUT'],
					},
				},
				description: 'Content-Type header value for Raw body type',
			},
			// Specify Body Options
			{
				displayName: 'Specify Body',
				name: 'specifyBody',
				type: 'options',
				displayOptions: { show: { sendBody: [true], method: ['PATCH', 'POST', 'PUT'], contentType: ['json', 'raw', 'form-urlencoded'] } },
				options: [
					{ name: 'Using Fields Below', value: 'keypair' },
					{ name: 'Using JSON', value: 'json', displayOptions: { show: { '/contentType': ['json'] } } },
					{ name: 'Using Raw Body', value: 'raw', displayOptions: { show: { '/contentType': ['raw'] } } },
				],
				default: 'keypair',
				description: 'How to specify the body content',
			},
			// Body Parameters (keypair)
			{
				displayName: 'Body Parameters',
				name: 'bodyParameters',
				type: 'fixedCollection',
				displayOptions: { show: { specifyBody: ['keypair'], sendBody: [true], method: ['PATCH', 'POST', 'PUT'], contentType: ['form-urlencoded', 'json'] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Parameter',
				default: { values: [{ name: '', value: '' }] },
				options: [
					{
						name: 'values',
						displayName: 'Parameter',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			// JSON Body
			{
				displayName: 'JSON',
				name: 'jsonBody',
				type: 'json',
				displayOptions: { show: { specifyBody: ['json'], sendBody: [true], method: ['PATCH', 'POST', 'PUT'], contentType: ['json'] } },
				default: '',
				placeholder: '{ "key": "value" }',
				required: true,
				description: 'The JSON body to send',
			},
			// Raw Body
			{
				displayName: 'Raw Body',
				name: 'rawBody',
				type: 'string',
				typeOptions: { rows: 4 },
				displayOptions: { show: { specifyBody: ['raw'], sendBody: [true], method: ['PATCH', 'POST', 'PUT'], contentType: ['raw'] } },
				default: '',
				placeholder: 'Enter raw body data...',
				required: true,
				description: 'The raw body content',
			},
			// Send Multipart Toggle
			{
				displayName: 'Send Form-Data',
				name: 'sendMultipart',
				type: 'boolean',
				default: false,
				description: 'Whether to send multipart form-data (Requires specifying fields)',
				displayOptions: { show: { sendBody: [true], method: ['POST', 'PUT', 'PATCH'], contentType: ['multipart-form-data'] } },
			},
			// Multipart Parameters
			{
				displayName: 'Form-Data Parameters',
				name: 'multipartParameters',
				type: 'fixedCollection',
				displayOptions: { show: { sendBody: [true], method: ['POST', 'PUT', 'PATCH'], contentType: ['multipart-form-data'], sendMultipart: [true] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Part',
				default: { values: [{ name: '', value: '', type: 'string' }] },
				description: 'Define the parts of the multipart request. Use expressions for binary data.',
				options: [
					{
						name: 'values',
						displayName: 'Part',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '', description: 'Name of the form field' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '', description: 'Value of the field. For files, use an expression resolving to binary data (e.g., {{$binary.data}}).' },
							{ displayName: 'Type', name: 'type', type: 'options', options: [{ name: 'String', value: 'string' }, { name: 'Binary', value: 'binary' }], default: 'string', description: 'Specify if the value is a string or binary data.' },
							{ displayName: 'Content-Type', name: 'contentType', type: 'string', default: '', description: '(Optional) Specify Content-Type for this part, especially for binary data.' },
							{ displayName: 'Filename', name: 'filename', type: 'string', default: '', description: '(Optional) Specify filename for binary data.' },
						],
					},
				],
			},
			// Send Query Toggle
			{
				displayName: 'Send Query Parameters',
				name: 'sendQuery',
				type: 'boolean',
				default: false,
				description: 'Whether to send query parameters with the request',
			},
			// Query Parameters
			{
				displayName: 'Query Parameters',
				name: 'queryParameters',
				type: 'fixedCollection',
				displayOptions: { show: { sendQuery: [true] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Parameter',
				default: { values: [{ name: '', value: '' }] },
				options: [
					{
						name: 'values',
						displayName: 'Parameter',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			// Send Headers Toggle
			{
				displayName: 'Send Headers',
				name: 'sendHeaders',
				type: 'boolean',
				default: false,
				description: 'Whether to send custom headers with the request',
			},
			// Headers
			{
				displayName: 'Headers',
				name: 'headerParameters',
				type: 'fixedCollection',
				displayOptions: { show: { sendHeaders: [true] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Header',
				default: { values: [{ name: '', value: '' }] },
				options: [
					{
						name: 'values',
						displayName: 'Header',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			// Options Collection
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{ displayName: 'Ignore Response Code', name: 'ignoreResponseCode', type: 'boolean', default: false, description: 'Whether to succeed even if the HTTP status code indicates an error' },
					{ displayName: 'Allow Unauthorized Certificates', name: 'allowUnauthorizedCerts', type: 'boolean', default: false, description: 'Whether to allow unauthorized certificates (e.g. self-signed)' },
					{ displayName: 'Timeout (ms)', name: 'timeout', type: 'number', typeOptions: { minValue: 1 }, default: 10000, description: 'Time in milliseconds to wait for the initial request to complete' },
					{ displayName: 'Proxy', name: 'proxy', type: 'string', default: '', placeholder: 'http://myproxy:3128', description: 'HTTP proxy to use for the request (e.g., http://user:pass@host:port)' },
					{ displayName: 'Response Format', name: 'responseFormat', type: 'options', options: [{ name: 'Autodetect', value: 'autodetect' }, { name: 'File', value: 'file' }, { name: 'JSON', value: 'json' }, { name: 'Text', value: 'text' }], default: 'autodetect', description: 'How to format the response data' },
					{ displayName: 'Response Character Encoding', name: 'responseCharacterEncoding', type: 'options', displayOptions: { show: { responseFormat: ['text', 'json', 'autodetect'] } }, options: [{ name: 'Autodetect', value: 'autodetect' }, { name: 'ISO-8859-1', value: 'latin1' }, { name: 'UTF-8', value: 'utf8' }], default: 'autodetect', description: 'Character encoding for text based response formats like JSON and Text.' },
					{ displayName: 'Full Response', name: 'fullResponse', type: 'boolean', default: false, description: 'Whether to return the full response object (including headers, status code) instead of just the body' },
				],
			},
			// Webhook Toggle
			{
				displayName: 'Wait for Webhook Response',
				name: 'waitForWebhookResponse',
				type: 'boolean',
				default: false,
				description: 'Whether to wait for an asynchronous response via webhook instead of using the direct HTTP response',
			},
			// Webhook Configuration
			{
				displayName: 'Webhook Configuration',
				name: 'webhookConfig',
				type: 'collection',
				placeholder: 'Configure Webhook Wait',
				default: {},
				displayOptions: { show: { waitForWebhookResponse: [true] } },
				options: [
					{ displayName: 'Webhook Method', name: 'webhookMethod', type: 'options', options: [{ name: 'POST', value: 'POST' }, { name: 'GET', value: 'GET' }, { name: 'PUT', value: 'PUT' }], default: 'POST', required: true, description: 'The HTTP method the external service will use to call the webhook' },
					{ displayName: 'Correlation ID Location (in Request)', name: 'correlationIdLocationInRequest', type: 'options', options: [{ name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' }, { name: 'Do Not Send', value: 'none' }], default: 'none', description: 'Where to place the unique correlation ID in the initial outbound HTTP request (if needed by the API)' },
					{ displayName: 'Correlation ID Parameter Name (in Request)', name: 'correlationIdParameterName', type: 'string', default: 'correlationId', required: true, displayOptions: { show: { './correlationIdLocationInRequest': ['query', 'header', 'bodyJsonPath'] } }, description: 'Name of the query parameter, header, or the JSON path (dot notation) for the correlation ID in the initial request' },
					{ displayName: 'Callback URL Parameter Name (in Request)', name: 'callbackUrlParameterNameInRequest', type: 'string', default: 'callbackUrl', required: true, description: 'Parameter name (query, header, or body JSON path) used to send the generated webhook callback URL in the initial request' },
					{ displayName: 'Callback URL Location (in Request)', name: 'callbackUrlLocationInRequest', type: 'options', options: [{ name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' }], default: 'bodyJsonPath', description: 'Where to place the webhook callback URL in the initial outbound HTTP request' },
					{ displayName: 'Correlation ID Location (in Webhook)', name: 'correlationIdLocationInWebhook', type: 'options', options: [{ name: 'Query Parameter', value: 'query' }, { name: 'Header', value: 'header' }, { name: 'Body (JSON Path)', value: 'bodyJsonPath' }], required: true, default: 'bodyJsonPath', description: 'Where to find the correlation ID in the incoming webhook data to match the request' },
					{ displayName: 'Correlation ID Parameter Name (in Webhook)', name: 'correlationIdParameterNameInWebhook', type: 'string', default: 'correlationId', required: true, description: 'Name of the query parameter, header, or the JSON path (dot notation) for the correlation ID in the webhook response' },
					{ displayName: 'Webhook Timeout (seconds)', name: 'timeoutWebhook', type: 'number', typeOptions: { minValue: 1 }, default: 120, description: 'Maximum time (in seconds) to wait for the correct webhook response' },
					{ displayName: 'Webhook Response Includes', name: 'webhookResponseIncludes', type: 'multiOptions', options: [{ name: 'Body', value: 'body' }, { name: 'Headers', value: 'headers' }, { name: 'Query Parameters', value: 'query' }], required: true, default: ['body'], description: 'Which parts of the incoming webhook request to include in the node output' },
				],
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: '={{$parameter.webhookConfig.webhookMethod || "POST"}}', // Dynamic method
				isFullPath: false,
				path: 'webhook/:webhookId',
				responseCode: '200',
				// No need for webhookMethods here
			},
		],
		// Removed webhookMethods array from here
	};

	/**
	 * Static helper to handle correlation data injection/extraction.
	 */
	static handleCorrelationData(
		location: string | undefined,
		paramName: string,
		target: IHttpRequestOptions | IWebhookRequestObject,
		valueToSet: string | undefined, // Only used when injecting
		isWebhookRequest: boolean, // True if target is webhook req, false if HTTP req options
		node: INode, // Node context for errors
	): string | undefined {

		try {
			if (location === 'query') {
				if (isWebhookRequest) {
					return (target as IWebhookRequestObject).query?.[paramName] as string | undefined;
				} else {
					const options = target as IHttpRequestOptions;
					options.qs = options.qs ?? {};
					(options.qs as IDataObject)[paramName] = valueToSet;
					return undefined; // Not extracting
				}
			} else if (location === 'header') {
				if (isWebhookRequest) {
					// Header names are case-insensitive, normalize lookup
					const headers = (target as IWebhookRequestObject).headers ?? {};
					const lowerParamName = paramName.toLowerCase();
					const headerKey = Object.keys(headers).find(k => k.toLowerCase() === lowerParamName);
					return headerKey ? headers[headerKey] as string : undefined;
				} else {
					const options = target as IHttpRequestOptions;
					options.headers = options.headers ?? {};
					(options.headers as IDataObject)[paramName] = valueToSet;
					return undefined;
				}
			} else if (location === 'bodyJsonPath') {
				const body = (target as any).body; // Use 'any' for flexibility
				if (isWebhookRequest) {
					if (typeof body === 'object' && body !== null) {
						return objectPath.get(body, paramName) as string | undefined;
					}
					return undefined; // Body is not an object or path not found
				} else { // Injecting into request body
					let bodyData = (target as IHttpRequestOptions).body;
					const contentType = (target as IHttpRequestOptions).headers?.['content-type'] as string | undefined;

					// Ensure body is an object for JSON path injection
					if (contentType?.includes('json')) {
						if (typeof bodyData !== 'object' || bodyData === null) {
							try {
								// If bodyData is a stringified JSON, parse it
								if (typeof bodyData === 'string' && bodyData.trim().startsWith('{')) {
									bodyData = JSON.parse(bodyData);
								} else {
									bodyData = {}; // Start with empty object if not valid JSON
								}
							} catch {
								bodyData = {}; // Start with empty object on parse error
							}
						}
						// Now bodyData should be an object
						objectPath.set(bodyData as object, paramName, valueToSet);
						(target as IHttpRequestOptions).body = bodyData; // Assign potentially modified body back
						(target as IHttpRequestOptions).json = true; // Ensure json flag is set
					} else {
						node.contextData.logger?.warn(`Cannot inject into body path '${paramName}'. Body Content-Type must be JSON.`);
					}
					return undefined;
				}
			} else if (location === 'none' && !isWebhookRequest) {
				// Do nothing for 'none' when injecting
				return undefined;
			}
		} catch (error: any) {
			node.contextData.logger?.error(`Error handling correlation data at ${location} ('${paramName}'): ${error.message}`);
			// Depending on context, might throw or return undefined
			if (isWebhookRequest) return undefined; // Don't block webhook by throwing
		}

		// Default return if location invalid or error occurred during extraction
		return undefined;
	}


	// --- Execute Method ---
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const node = this.getNode();

		// Retrieve static data for listeners at the beginning
		const staticData = this.getWorkflowStaticData('node');
		// Ensure listeners object exists in staticData (initialize if first run)
		if (!staticData.listeners) {
			staticData.listeners = {};
		}
		const webhookListeners = staticData.listeners as { [key: string]: IWebhookListener }; // Assert type

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const url = this.getNodeParameter('url', itemIndex, '') as string;
				const method = this.getNodeParameter('method', itemIndex, 'GET') as IHttpRequestMethods;
				const authentication = this.getNodeParameter('authentication', itemIndex, 'none') as string;
				const sendBody = this.getNodeParameter('sendBody', itemIndex, false) as boolean;
				const contentType = this.getNodeParameter('contentType', itemIndex, 'json') as string;
				const rawContentType = this.getNodeParameter('rawContentType', itemIndex, 'text/plain') as string;
				const specifyBody = this.getNodeParameter('specifyBody', itemIndex, 'keypair') as string;
				const sendMultipart = this.getNodeParameter('sendMultipart', itemIndex, false) as boolean;
				const sendQuery = this.getNodeParameter('sendQuery', itemIndex, false) as boolean;
				const sendHeaders = this.getNodeParameter('sendHeaders', itemIndex, false) as boolean;

				const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
				const fullResponse = options.fullResponse as boolean ?? false;

				const waitForWebhookResponse = this.getNodeParameter('waitForWebhookResponse', itemIndex, false) as boolean;
				const webhookConfig = this.getNodeParameter('webhookConfig', itemIndex, {}) as IWebhookConfig;

				// --- Base Request Options ---
				const requestOptions: IHttpRequestOptions = {
					method,
					url: url, // Changed from uri to url
					gzip: true,
					rejectUnauthorized: !(options.allowUnauthorizedCerts as boolean ?? false), // Default rejectUnauthorized = true
					timeout: options.timeout as number || 10000,
					headers: {},
					qs: {},
					// Note: body, json, formData, proxy, responseType, encoding are set below or cast to any
				};

				// --- Proxy ---
				if (options.proxy) {
					(requestOptions as any).proxy = options.proxy as string; // Cast needed if type expects object
				}

				// --- Response Format & Encoding ---
				const responseFormat = options.responseFormat as string || 'autodetect';
				const responseCharacterEncoding = options.responseCharacterEncoding as string || 'autodetect';

				const reqOptsAny = requestOptions as any;
				if (responseFormat === 'json') reqOptsAny.responseType = 'json';
				else if (responseFormat === 'text') reqOptsAny.responseType = 'text';
				else reqOptsAny.responseType = 'arraybuffer';

				if (reqOptsAny.responseType === 'text' && responseCharacterEncoding !== 'autodetect') {
					reqOptsAny.encoding = responseCharacterEncoding as BufferEncoding;
				} else {
                    reqOptsAny.encoding = null; // Let request lib handle buffer decoding
                }

				// --- Headers ---
				if (sendHeaders) {
					const headerValues = this.getNodeParameter('headerParameters.values', itemIndex, []) as Array<{ name?: string, value?: string }>;
					requestOptions.headers = headerValues.reduce((acc, param) => {
						if (param.name) acc[param.name] = param.value ?? '';
						return acc;
					}, requestOptions.headers as IDataObject);
				}

				// --- Query Parameters ---
				if (sendQuery) {
					const queryValues = this.getNodeParameter('queryParameters.values', itemIndex, []) as Array<{ name?: string, value?: string }>;
					requestOptions.qs = queryValues.reduce((acc, param) => {
						if (param.name) acc[param.name] = param.value ?? '';
						return acc;
					}, requestOptions.qs as IDataObject);
				}

				// --- Body ---
				let bodyData: any = undefined;
				if (sendBody && ['POST', 'PATCH', 'PUT'].includes(method)) {
					requestOptions.headers = requestOptions.headers ?? {};

					if (contentType === 'json') {
						(requestOptions.headers as IDataObject)['content-type'] = 'application/json; charset=utf-8';
						if (specifyBody === 'keypair') {
							const bodyParams = this.getNodeParameter('bodyParameters.values', itemIndex, []) as Array<{ name?: string, value?: any }>;
							bodyData = bodyParams.reduce((acc, param) => { if (param.name) acc[param.name] = param.value; return acc; }, {} as IDataObject);
						} else if (specifyBody === 'json') {
							const jsonBodyStr = this.getNodeParameter('jsonBody', itemIndex, '{}') as string;
							try { bodyData = JSON.parse(jsonBodyStr); }
							catch (e: any) { throw new NodeOperationError(node, `Invalid JSON in body: ${e.message}`, { itemIndex }); }
						}
						requestOptions.json = true;
						requestOptions.body = bodyData;

					} else if (contentType === 'form-urlencoded') {
						(requestOptions.headers as IDataObject)['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
						if (specifyBody === 'keypair') {
							const bodyParams = this.getNodeParameter('bodyParameters.values', itemIndex, []) as Array<{ name?: string, value?: string }>;
							const params = new URLSearchParams();
							bodyParams.forEach(param => { if (param.name) params.append(param.name, param.value ?? ''); });
							bodyData = params.toString();
							requestOptions.body = bodyData;
							requestOptions.json = false;
						} else {
							throw new NodeOperationError(node, 'For form-urlencoded, use "Using Fields Below".', { itemIndex });
						}

					} else if (contentType === 'multipart-form-data') {
						if (sendMultipart) {
							const multipartParams = this.getNodeParameter('multipartParameters.values', itemIndex, []) as Array<{ name?: string, value?: any, type?: string, contentType?: string, filename?: string }>;
							const formData: IDataObject = {};
							for (const part of multipartParams) {
								if (!part.name) continue;
								let value = part.value;
								if (part.type === 'binary') {
									// Use 'any' cast for helper due to TS2684
									const binaryData = await (this.helpers as any).assertBinaryData(itemIndex, value);
									const partOptions: { contentType?: string, filename?: string } = {};
									if (part.contentType) partOptions.contentType = part.contentType;
									const filename = part.filename || binaryData.fileName;
									if (filename) partOptions.filename = filename;
									if (binaryData.mimeType && !partOptions.contentType) partOptions.contentType = binaryData.mimeType;
									value = { value: Buffer.from(binaryData.data, 'base64'), options: partOptions };
								}
								formData[part.name] = value;
							}
							(requestOptions as any).formData = formData; // Cast needed if type missing formData
							delete (requestOptions.headers as IDataObject)['content-type'];
							requestOptions.json = false;
						} else {
							throw new NodeOperationError(node, 'For multipart/form-data, enable "Send Form-Data".', { itemIndex });
						}

					} else if (contentType === 'raw') {
						(requestOptions.headers as IDataObject)['content-type'] = rawContentType;
						bodyData = this.getNodeParameter('rawBody', itemIndex, '') as string;
						requestOptions.body = bodyData;
						requestOptions.json = false;

					} else if (contentType === 'none') {
						delete (requestOptions.headers as IDataObject)['content-type'];
					}
				} // End of sendBody block


				// --- Webhook Wait Logic ---
				if (waitForWebhookResponse) {
					const correlationIdValue = uuidv4();
					const webhookUniqueId = `${this.getExecutionId()}-${node.id}-${itemIndex}-${uuidv4().substring(0, 8)}`;

					const {
						webhookMethod = 'POST',
						correlationIdLocationInRequest = 'none',
						correlationIdParameterName = 'correlationId',
						callbackUrlParameterNameInRequest = 'callbackUrl',
						callbackUrlLocationInRequest = 'bodyJsonPath',
						timeoutWebhook = 120,
					} = webhookConfig;

					// 1. Get Webhook URL using webhookFunctions (TS2339 fix)
					const webhookUrl = this.webhookFunctions.getWebhookUrl('default');
                    if (!webhookUrl) {
                         throw new NodeOperationError(node, 'Could not generate webhook URL. Is Instance Base URL configured?', { itemIndex });
                    }
                    const finalWebhookUrl = webhookUrl.replace(':webhookId', webhookUniqueId);

					// 2. Inject Correlation ID
					AsyncHttpRequest.handleCorrelationData(
						correlationIdLocationInRequest,
						correlationIdParameterName as string,
						requestOptions,
						correlationIdValue,
						false,
						node,
					);

					// 3. Inject Callback URL
					AsyncHttpRequest.handleCorrelationData(
						callbackUrlLocationInRequest,
						callbackUrlParameterNameInRequest as string,
						requestOptions,
						finalWebhookUrl,
						false,
						node,
					);

					// 4. Setup Waiter Promise & Listener
					const waitPromise = new Promise<IDataObject>((resolve, reject) => {
						const timeoutSeconds = (timeoutWebhook as number) * 1000;
						const timer = setTimeout(() => {
							const listener = webhookListeners[webhookUniqueId];
							if (listener) {
								const listenerItemIndex = listener.itemIndex;
								delete webhookListeners[webhookUniqueId];
								this.logger.warn(`Webhook ${webhookUniqueId} timed out after ${timeoutWebhook} seconds.`);
								reject(new NodeOperationError(node, `Webhook wait timed out for ID ${webhookUniqueId}`, { itemIndex: listenerItemIndex }));
							} else {
								this.logger.warn(`Timeout triggered for ${webhookUniqueId}, listener already removed.`);
							}
						}, timeoutSeconds);

						webhookListeners[webhookUniqueId] = {
							resolve: resolve,
							reject: reject,
							timeoutTimer: timer,
							expectedMethod: (webhookMethod as string).toUpperCase(),
							correlationId: correlationIdValue,
							webhookConfig: webhookConfig,
							itemIndex: itemIndex,
						};
						this.logger.debug(`Webhook Listener Added: ${webhookUniqueId} (Corr: ${correlationIdValue})`);
					});

					// 5. Send Initial Request (use 'any' cast for helper due to TS2684)
					try {
						this.logger.debug(`Sending initial request [${itemIndex}] for ${webhookUniqueId}`);
						const initialResponse = await (this.helpers as any).requestWithAuthentication(
							authentication,
							requestOptions,
							itemIndex,
						);
						this.logger.debug(`Initial request [${itemIndex}] sent for ${webhookUniqueId}. Status: ${initialResponse?.statusCode}. Waiting...`);
					} catch (error: any) {
						const listenerData = webhookListeners[webhookUniqueId];
						if (listenerData) {
							clearTimeout(listenerData.timeoutTimer);
							delete webhookListeners[webhookUniqueId];
							this.logger.debug(`Webhook Listener Removed (initial req error): ${webhookUniqueId}`);
						}
						if (!options.ignoreResponseCode || !isNodeApiError(error)) {
							throw error;
						} else {
							this.logger.warn(`Initial request [${itemIndex}] failed but ignoring. Error: ${error.message}. Status: ${error.context?.statusCode}. Waiting for webhook ${webhookUniqueId}.`);
						}
					}

					// 6. Wait for Webhook Promise
					this.logger.debug(`Waiting for webhook ${webhookUniqueId}...`);
					const webhookResult = await waitPromise;

					// 7. Add webhook result to output
					returnData.push({ json: webhookResult, pairedItem: { item: itemIndex } });

				} else {
					// --- Standard HTTP Request (No Webhook Wait) ---
					let response: NodeExecutionWithMetadata;
					try {
						// Use 'any' cast for helper due to TS2684
						response = await (this.helpers as any).requestWithAuthentication(
							authentication,
							requestOptions,
							itemIndex,
						);

						let responseData: any; // Final data
						let binaryPropertyName: string | undefined = undefined;

						const responseBody = response.body;
						const isBuffer = Buffer.isBuffer(responseBody);
						const headers = response.headers as IDataObject | undefined;
						const contentTypeHeader = headers?.['content-type']; // Reuse this

						if (!fullResponse) {
							if (responseFormat === 'file') {
								if (!isBuffer) throw new NodeOperationError(node, 'Response body not binary, cannot format as file.', { itemIndex });
								// Safer split (TS2339 fix)
								const mimeType = typeof contentTypeHeader === 'string' ? contentTypeHeader.split(';')[0] : 'application/octet-stream';
								// Use 'any' cast for helper due to TS2684
								const binaryData = await (this.helpers as any).prepareBinaryData(responseBody, undefined, mimeType);
								binaryPropertyName = 'data';
								returnData.push({ json: {}, binary: { [binaryPropertyName]: binaryData }, pairedItem: { item: itemIndex } });
								continue;

							} else if (responseFormat === 'text') {
								const encoding = reqOptsAny.encoding as BufferEncoding | undefined;
								responseData = isBuffer ? responseBody.toString(encoding) : String(responseBody);
							} else if (responseFormat === 'json') {
								if (typeof responseBody === 'object' && !isBuffer) {
									responseData = responseBody;
								} else {
									const encoding = reqOptsAny.encoding as BufferEncoding | undefined ?? 'utf8';
									const textBody = isBuffer ? responseBody.toString(encoding) : String(responseBody);
									try { responseData = JSON.parse(textBody); }
									catch (e: any) { throw new NodeOperationError(node, `Response body not valid JSON: ${e.message}`, { itemIndex }); }
								}
							} else { // Autodetect
								if (typeof responseBody === 'object' && !isBuffer) {
									responseData = responseBody;
								} else {
									const encoding = reqOptsAny.encoding as BufferEncoding | undefined ?? 'utf8';
									responseData = isBuffer ? responseBody.toString(encoding) : String(responseBody);
									// Safer includes check (TS2339 fix)
                                    if (typeof contentTypeHeader === 'string' && contentTypeHeader.includes('json') && typeof responseData === 'string') {
                                        try { responseData = JSON.parse(responseData); } catch(e) { /* Ignore */ }
                                    }
								}
							}
						} else { // Full Response
							let processedBody: any = responseBody; // Declare as any (TS2322 fix)
							if (isBuffer) {
                                const bufferInfo = `Buffer data (length: ${responseBody.length}, type: ${contentTypeHeader || 'unknown'})`;
								processedBody = bufferInfo;
							}
							responseData = {
								headers: response.headers,
								statusCode: response.statusCode,
								statusMessage: response.statusMessage,
								body: processedBody,
							};
						}

						if (binaryPropertyName === undefined) {
							returnData.push({ json: responseData, pairedItem: { item: itemIndex } });
						}

					} catch (error: any) {
						if (!options.ignoreResponseCode || !isNodeApiError(error)) {
							throw error;
						}

						// Safer error handling (TS2533, TS2339 fixes)
						const errorContext = isNodeApiError(error) ? error.context : {}; // Get context only if it's a NodeApiError
						const errorOutput: IDataObject = {
							error: {
								message: error.message,
								httpCode: errorContext?.statusCode,
								httpMessage: errorContext?.statusMessage,
								headers: errorContext?.headers,
								body: errorContext?.body,
							},
						};
						// Add stack safely if error is an Error instance
						if (error instanceof Error && error.stack) {
							(errorOutput.error as IDataObject).stack = error.stack.split('\n').map((l: string) => l.trim());
						}

						returnData.push({ json: errorOutput, pairedItem: { item: itemIndex } });
					}
				} // End of standard request block

			} catch (error: any) {
				if (this.continueOnFail()) {
					const errorJson: IDataObject = { error: { message: error.message } };
                    // Add stack safely
                    if (error instanceof Error && error.stack) {
                        errorJson.error.stack = error.stack.split('\n').map((l: string) => l.trim());
                    }
                    // Add context safely
                    if (error instanceof NodeOperationError && error.context) {
                        errorJson.error.context = error.context;
                    } else if (isNodeApiError(error) && error.context) {
                        errorJson.error.context = error.context;
                    }

					returnData.push({ json: errorJson, pairedItem: { item: itemIndex } });
					continue;
				}
				throw error;
			}
		} // End of item loop

		return [returnData];
	}


	// --- Webhook Method ---
	static async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject() as IWebhookRequestObject;
		const node = this.getNode();
		const webhookUniqueId = req.params?.webhookId as string | undefined;

		if (!webhookUniqueId) {
			this.logger.warn(`Webhook received without 'webhookId'.`);
			throw new NodeOperationError(node, 'Missing webhook identifier.');
		}

		this.logger.debug(`Webhook received for ID: ${webhookUniqueId}`);

		const staticData = this.getWorkflowStaticData('node');
		const webhookListeners = staticData.listeners as { [key: string]: IWebhookListener } || {};
		const listenerData = webhookListeners[webhookUniqueId];

		if (!listenerData) {
			this.logger.warn(`Webhook ignored (unknown/timed-out ID): ${webhookUniqueId}.`);
            throw new NodeOperationError(node, `Webhook listener not found or timed out: ${webhookUniqueId}`);
		}

		const { resolve, reject, timeoutTimer, expectedMethod, correlationId, webhookConfig, itemIndex } = listenerData;
		const receivedMethod = (req.method ?? '').toUpperCase();

		if (receivedMethod !== expectedMethod) {
			this.logger.warn(`Webhook ${webhookUniqueId}: Method mismatch (${receivedMethod} vs ${expectedMethod}). Ignoring.`);
            throw new NodeOperationError(node, `Incorrect method ${receivedMethod} for webhook ${webhookUniqueId}. Expected ${expectedMethod}.`, { itemIndex });
		}

		try {
			const receivedCorrelationId = AsyncHttpRequest.handleCorrelationData(
				webhookConfig.correlationIdLocationInWebhook,
				webhookConfig.correlationIdParameterNameInWebhook as string,
				req,
				undefined,
				true,
				node,
			) as string | undefined;

			this.logger.debug(`Webhook ${webhookUniqueId}: Expecting Corr ID: ${correlationId}, Received: ${receivedCorrelationId}`);

			if (receivedCorrelationId === correlationId) {
				clearTimeout(timeoutTimer);
				delete webhookListeners[webhookUniqueId];
				this.logger.info(`Webhook ${webhookUniqueId}: Correlation ID match! Resolving.`);

				const webhookResult: IDataObject = {};
				const includes = Array.isArray(webhookConfig.webhookResponseIncludes) ? webhookConfig.webhookResponseIncludes : ['body'];

				// Use 'any' cast for req.body (TS2322 fix)
				if (includes.includes('body')) webhookResult.body = req.body as any;
				if (includes.includes('headers')) webhookResult.headers = req.headers;
				if (includes.includes('query')) webhookResult.query = req.query;

				resolve(webhookResult);
				return { noWebhookResponse: false };

			} else {
				this.logger.warn(`Webhook ${webhookUniqueId}: Correlation ID mismatch (${receivedCorrelationId} vs ${correlationId}). Ignoring.`);
                throw new NodeOperationError(node, `Correlation ID mismatch for webhook ${webhookUniqueId}.`, { itemIndex });
			}
		} catch (error: any) {
			this.logger.error(`Webhook ${webhookUniqueId}: Error processing: ${error.message}`, { error: error.stack });

            if (webhookListeners[webhookUniqueId]) { // Check existence before cleanup
			    clearTimeout(timeoutTimer);
			    delete webhookListeners[webhookUniqueId];
                 if (!(error instanceof NodeOperationError && error.message.includes('Correlation ID mismatch'))) {
                    reject(new NodeOperationError(node, `Error processing webhook ${webhookUniqueId}: ${error.message}`, { itemIndex }));
                 }
            }
			throw error; // Re-throw to signal error response
		}
	}
}
