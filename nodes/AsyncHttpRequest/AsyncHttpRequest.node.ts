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
	BinaryHelperFunctions, // Types for binary helpers
	RequestHelperFunctions, // Types for request helpers
	NodeExecutionWithMetadata, // Type for getWorkflowStaticData
	INode, // Base node interface
	IWebhookResponseData, // Type for webhook response if needed
	IBinaryKeyData, // For binary data output
	IPairedItemData, // For pairing items
	GenericValue, // Generic type for JSON data
} from 'n8n-workflow';

import { v4 as uuidv4 } from 'uuid';
import * as objectPath from 'object-path'; // Ensure this is installed `npm i object-path @types/object-path`

// --- Interfaces ---

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
	body: IDataObject | string | unknown; // Body type can be diverse
	method?: string;
	path?: string;
}

// Type guard for NodeApiError
function isNodeApiError(error: any): error is NodeApiError {
	return error instanceof NodeApiError && typeof error.context === 'object';
}

// Store active listeners associated with a unique ID (ExecutionID-NodeID-ItemIndex-random)
// Needs to be static or managed outside the class instance if multiple executions happen concurrently.
// Using getWorkflowStaticData is the recommended n8n way.
// let webhookListeners: { [key: string]: IWebhookListener } = {}; // Replaced by getWorkflowStaticData

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
		// inputs: ['main'], // Removed to default to main
		// outputs: ['main'], // Removed to default to main
		credentials: [
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
			// --- Standard HTTP Request properties ---
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'http://example.com/resource',
				description: 'The URL to send the request to',
			},
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
			{
				displayName: 'Send Body',
				name: 'sendBody',
				type: 'boolean',
				default: false,
				description: 'Whether to send a body with the request',
				displayOptions: { show: { method: ['PATCH', 'POST', 'PUT'] } },
			},
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
			{
				displayName: 'Specify Body',
				name: 'specifyBody',
				type: 'options',
				displayOptions: { show: { sendBody: [true], method: ['PATCH', 'POST', 'PUT'], contentType: ['json', 'raw', 'form-urlencoded'] } },
				options: [
					{ name: 'Using Fields Below', value: 'keypair' },
					// Corrected displayOptions within options (use absolute path from root)
					{ name: 'Using JSON', value: 'json', displayOptions: { show: { '/contentType': ['json'] } } },
					{ name: 'Using Raw Body', value: 'raw', displayOptions: { show: { '/contentType': ['raw'] } } },
				],
				default: 'keypair',
				description: 'How to specify the body content',
			},
			{
				displayName: 'Body Parameters',
				name: 'bodyParameters',
				type: 'fixedCollection',
				displayOptions: { show: { specifyBody: ['keypair'], sendBody: [true], method: ['PATCH', 'POST', 'PUT'], contentType: ['form-urlencoded', 'json'] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Parameter',
				default: { values: [{ name: '', value: '' }] }, // Default structure for fixed collection
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
			// --- Multipart form-data section ---
			{
				displayName: 'Send Form-Data',
				name: 'sendMultipart',
				type: 'boolean',
				default: false,
				description: 'Whether to send multipart form-data (Requires specifying fields)',
				displayOptions: { show: { sendBody: [true], method: ['POST', 'PUT', 'PATCH'], contentType: ['multipart-form-data'] } },
			},
			{
				displayName: 'Form-Data Parameters',
				name: 'multipartParameters',
				type: 'fixedCollection',
				displayOptions: { show: { sendBody: [true], method: ['POST', 'PUT', 'PATCH'], contentType: ['multipart-form-data'], sendMultipart: [true] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Part',
				default: { values: [{ name: '', value: '', type: 'string' }] }, // Default structure for fixed collection
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
			{
				displayName: 'Send Query Parameters',
				name: 'sendQuery',
				type: 'boolean',
				default: false,
				description: 'Whether to send query parameters with the request',
			},
			{
				displayName: 'Query Parameters',
				name: 'queryParameters',
				type: 'fixedCollection',
				displayOptions: { show: { sendQuery: [true] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Parameter',
				default: { values: [{ name: '', value: '' }] }, // Default structure for fixed collection
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
			{
				displayName: 'Send Headers',
				name: 'sendHeaders',
				type: 'boolean',
				default: false,
				description: 'Whether to send custom headers with the request',
			},
			{
				displayName: 'Headers',
				name: 'headerParameters',
				type: 'fixedCollection',
				displayOptions: { show: { sendHeaders: [true] } },
				typeOptions: { multipleValues: true },
				placeholder: 'Add Header',
				default: { values: [{ name: '', value: '' }] }, // Default structure for fixed collection
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
			// --- Webhook Response properties ---
			{
				displayName: 'Wait for Webhook Response',
				name: 'waitForWebhookResponse',
				type: 'boolean',
				default: false,
				description: 'Whether to wait for an asynchronous response via webhook instead of using the direct HTTP response',
			},
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
					// Corrected displayOptions path syntax (use relative './')
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
		// --- Webhook Registration ---
		webhooks: [
			{
				name: 'default',
				httpMethod: '={{$parameter.webhookConfig.webhookMethod || "POST"}}', // Dynamically set method
				isFullPath: false,
				path: 'webhook/:webhookId', // Path to capture unique ID
				responseCode: '200', // Default success code
				// webhookMethods are defined at the root level now
			},
		],
		webhookMethods: ['POST', 'GET', 'PUT'], // Explicitly list possible methods
	};


	/**
	 * Handles injecting or extracting correlation data (ID or URL).
	 * @param location Where the data is (query, header, bodyJsonPath, none)
	 * @param paramName Name of parameter/header or JSON path
	 * @param data Request options object (for injection) or Webhook request object (for extraction)
	 * @param valueToSet Value to inject (string), or undefined if extracting
	 * @param isWebhookRequest True if extracting from webhook, false if injecting into request
	 * @param node The INode instance for context
	 * @returns The extracted value (string | undefined) if extracting, or void if injecting.
	 * @throws NodeOperationError if JSON path setting/getting fails or location is invalid.
	 */
	static handleCorrelationData(
		location: 'query' | 'header' | 'bodyJsonPath' | 'none' | undefined,
		paramName: string,
		data: IHttpRequestOptions | IWebhookRequestObject,
		valueToSet?: string,
		isWebhookRequest: boolean = false,
		node?: INode, // Added node for error context
	): string | undefined | void {
		if (location === 'none') {
			return isWebhookRequest ? undefined : void 0;
		}

		if (!location || !paramName) {
			throw new NodeOperationError(node ?? {} as INode, `Invalid configuration: Location ('${location}') or Parameter Name ('${paramName}') missing for correlation/callback data.`);
		}

		if (isWebhookRequest) {
			// --- Extraction from Webhook Request ---
			const req = data as IWebhookRequestObject;
			if (location === 'query') {
				return req.query?.[paramName] as string | undefined;
			} else if (location === 'header') {
				const headerValue = req.headers?.[paramName.toLowerCase()]; // Headers often lowercased
				return Array.isArray(headerValue) ? headerValue[0] : headerValue as string | undefined;
			} else if (location === 'bodyJsonPath') {
				try {
					// Ensure body is parsed if JSON string
                    let body = req.body;
                    if (typeof body === 'string') {
                        try { body = JSON.parse(body); } catch (e) { /* ignore if not json */ }
                    }
					return objectPath.get(body as object, paramName) as string | undefined;
				} catch (e: any) {
					throw new NodeOperationError(node ?? {} as INode, `Failed to get data from webhook body path '${paramName}': ${e.message}`);
				}
			}
		} else {
			// --- Injection into HTTP Request Options ---
			const options = data as IHttpRequestOptions;
			if (location === 'query') {
				options.qs = options.qs ?? {};
				(options.qs as IDataObject)[paramName] = valueToSet;
			} else if (location === 'header') {
				options.headers = options.headers ?? {};
				(options.headers as IDataObject)[paramName] = valueToSet;
			} else if (location === 'bodyJsonPath') {
				try {
					// Ensure body exists and is an object for path setting
					if (typeof options.body !== 'object' || options.body === null) {
						// If body is stringified JSON, parse it. If not JSON or empty, initialize.
						if (typeof options.body === 'string' && options.body.trim().startsWith('{')) {
							try { options.body = JSON.parse(options.body); }
							catch (e) { options.body = {}; } // Initialize if parsing fails
						} else {
							options.body = {}; // Initialize if not object or parseable JSON
						}
					}
                    // Ensure body is not null after potential parsing/initialization
                    if (options.body === null) options.body = {};

					objectPath.set(options.body as object, paramName, valueToSet);
                    // If the library needs the body to be stringified for JSON content-type, do it AFTER setting the path
                    // Check if `options.json` is true AND body is now an object
                    if (options.json && typeof options.body === 'object' && options.body !== null) {
                        // Stringify only if the request helper doesn't do it automatically based on options.json
                        // Most helpers (like `request`) handle object bodies automatically when options.json=true
                        // So, usually, no need to stringify here. If needed, uncomment:
                        // options.body = JSON.stringify(options.body);
                    }

				} catch (e: any) {
					throw new NodeOperationError(node ?? {} as INode, `Failed to set data in request body path '${paramName}': ${e.message}`);
				}
			}
			return void 0; // Indicate success for injection
		}
	}

	// --- Execute Method ---
	// 'this' context is IExecuteFunctions
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const node = this.getNode(); // Get node instance for context

		// Retrieve or initialize webhook listeners from static data
		const staticData = this.getWorkflowStaticData('node');
		if (!staticData.listeners) {
			staticData.listeners = {};
		}
		const webhookListeners = staticData.listeners as { [key: string]: IWebhookListener };


		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const authentication = this.getNodeParameter('authentication', itemIndex) as string;
				const url = this.getNodeParameter('url', itemIndex, '') as string;
				const method = this.getNodeParameter('method', itemIndex, 'GET') as IHttpRequestMethods;
				const sendBody = this.getNodeParameter('sendBody', itemIndex, false) as boolean;
				const contentType = this.getNodeParameter('contentType', itemIndex, 'json') as string;
				const rawContentType = this.getNodeParameter('rawContentType', itemIndex, 'text/plain') as string;
				const specifyBody = this.getNodeParameter('specifyBody', itemIndex, 'keypair') as string;
				const sendMultipart = this.getNodeParameter('sendMultipart', itemIndex, false) as boolean;
				const sendQuery = this.getNodeParameter('sendQuery', itemIndex, false) as boolean;
				const sendHeaders = this.getNodeParameter('sendHeaders', itemIndex, false) as boolean;
				const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject; // Use IDataObject for flexibility
				const fullResponse = options.fullResponse as boolean ?? false;

				const waitForWebhookResponse = this.getNodeParameter('waitForWebhookResponse', itemIndex, false) as boolean;
				const webhookConfig = this.getNodeParameter('webhookConfig', itemIndex, {}) as IWebhookConfig;

				// --- Base Request Options ---
				const requestOptions: IHttpRequestOptions = {
					method,
					uri: url,
					gzip: true,
					rejectUnauthorized: !options.allowUnauthorizedCerts as boolean ?? true, // Default to true if not set
					timeout: options.timeout as number || 10000, // Default timeout
					// Proxy: Handled by casting requestOptions to 'any' below due to type issues
					headers: {},
					qs: {},
					// responseType: Handled by casting requestOptions to 'any' below
					// encoding: Handled by casting requestOptions to 'any' below
					// body/json/formData: Set later based on content type
				};

				// --- Proxy ---
				// Cast to 'any' because IHttpRequestOptions might incorrectly type 'proxy' as object instead of string
				if (options.proxy) {
					(requestOptions as any).proxy = options.proxy as string;
				}

				// --- Response Format & Encoding ---
				const responseFormat = options.responseFormat as string || 'autodetect';
				const responseCharacterEncoding = options.responseCharacterEncoding as string || 'autodetect';

				// Cast to 'any' as IHttpRequestOptions might be missing 'responseType'/'encoding'
				const reqOptsAny = requestOptions as any;
				if (responseFormat === 'json') reqOptsAny.responseType = 'json';
				else if (responseFormat === 'text') reqOptsAny.responseType = 'text';
				else reqOptsAny.responseType = 'arraybuffer'; // Default to buffer for file/autodetect

				if (reqOptsAny.responseType === 'text' && responseCharacterEncoding !== 'autodetect') {
					reqOptsAny.encoding = responseCharacterEncoding as BufferEncoding;
				} else {
                    reqOptsAny.encoding = null; // Let request library handle buffer decoding or default (UTF8) for JSON/Text
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
				let bodyData: any = undefined; // Define bodyData outside the if block
				if (sendBody && ['POST', 'PATCH', 'PUT'].includes(method)) {
					requestOptions.headers = requestOptions.headers ?? {}; // Ensure headers exist

					if (contentType === 'json') {
						(requestOptions.headers as IDataObject)['content-type'] = 'application/json; charset=utf-8';
						if (specifyBody === 'keypair') {
							const bodyParams = this.getNodeParameter('bodyParameters.values', itemIndex, []) as Array<{ name?: string, value?: any }>;
							bodyData = bodyParams.reduce((acc, param) => {
								if (param.name) acc[param.name] = param.value;
								return acc;
							}, {} as IDataObject);
						} else if (specifyBody === 'json') {
							const jsonBodyStr = this.getNodeParameter('jsonBody', itemIndex, '{}') as string;
							try { bodyData = JSON.parse(jsonBodyStr); }
							catch (e: any) { throw new NodeOperationError(node, `Invalid JSON in body: ${e.message}`, { itemIndex }); }
						}
						requestOptions.json = true; // Use json flag for library
						requestOptions.body = bodyData; // Assign prepared body

					} else if (contentType === 'form-urlencoded') {
						(requestOptions.headers as IDataObject)['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
						if (specifyBody === 'keypair') {
							const bodyParams = this.getNodeParameter('bodyParameters.values', itemIndex, []) as Array<{ name?: string, value?: string }>;
							const params = new URLSearchParams();
							bodyParams.forEach(param => { if (param.name) params.append(param.name, param.value ?? ''); });
							bodyData = params.toString();
							requestOptions.body = bodyData;
							requestOptions.json = false; // Explicitly not JSON
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
									// Use await directly with this.helpers
									const binaryData = await this.helpers.assertBinaryData(itemIndex, value);
									const partOptions: { contentType?: string, filename?: string } = {};
									if (part.contentType) partOptions.contentType = part.contentType;
									const filename = part.filename || binaryData.fileName;
									if (filename) partOptions.filename = filename;
									if (binaryData.mimeType && !partOptions.contentType) partOptions.contentType = binaryData.mimeType;

									value = { value: Buffer.from(binaryData.data, 'base64'), options: partOptions };
								}
								formData[part.name] = value;
							}
							// Cast to 'any' as IHttpRequestOptions might be missing 'formData'
							(requestOptions as any).formData = formData; // Assign formData object
							delete (requestOptions.headers as IDataObject)['content-type']; // Let library set multipart header
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
						// Do not set body/json properties
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
						// Other webhookConfig properties are used in the webhook handler
					} = webhookConfig;

					// 1. Get Webhook URL
					// Use the specific webhook name 'default' defined in description
					// Use this.getWebhookUrl() directly
					const webhookUrl = this.getWebhookUrl('default');
                    if (!webhookUrl) {
                         throw new NodeOperationError(node, 'Could not generate webhook URL. Is Instance Base URL configured in n8n?', { itemIndex });
                    }
                    // Append the unique ID to the path manually IF getWebhookUrl doesn't handle :webhookId replacement
                    // Check n8n version behavior. Assuming it needs manual appending for now:
                    const finalWebhookUrl = webhookUrl.replace(':webhookId', webhookUniqueId);


					// 2. Inject Correlation ID (if needed)
					AsyncHttpRequest.handleCorrelationData(
						correlationIdLocationInRequest,
						correlationIdParameterName as string,
						requestOptions, // Pass options object
						correlationIdValue,
						false, // isWebhookRequest = false
						node, // Pass node context
					);

					// 3. Inject Callback URL
					AsyncHttpRequest.handleCorrelationData(
						callbackUrlLocationInRequest,
						callbackUrlParameterNameInRequest as string,
						requestOptions, // Pass options object
						finalWebhookUrl, // Pass the constructed URL
						false, // isWebhookRequest = false
						node, // Pass node context
					);

					// 4. Setup Waiter Promise & Listener
					const waitPromise = new Promise<IDataObject>((resolve, reject) => {
						const timeoutSeconds = (timeoutWebhook as number) * 1000;
						const timer = setTimeout(() => {
							const listener = webhookListeners[webhookUniqueId]; // Check before accessing
							if (listener) {
								const listenerItemIndex = listener.itemIndex;
								delete webhookListeners[webhookUniqueId]; // Clean up listener
								this.logger.warn(`Webhook ${webhookUniqueId} timed out after ${timeoutWebhook} seconds.`);
								reject(new NodeOperationError(node, `Webhook wait timed out for ID ${webhookUniqueId}`, { itemIndex: listenerItemIndex }));
							} else {
								this.logger.warn(`Timeout triggered for webhook ${webhookUniqueId}, but listener was already removed.`);
							}
						}, timeoutSeconds);

						// Store listener data correctly
						webhookListeners[webhookUniqueId] = {
							resolve: resolve,
							reject: reject,
							timeoutTimer: timer,
							expectedMethod: (webhookMethod as string).toUpperCase(),
							correlationId: correlationIdValue,
							webhookConfig: webhookConfig, // Store the config for the webhook handler
							itemIndex: itemIndex, // Store itemIndex for error reporting
						};
						this.logger.debug(`Webhook Listener Added: ${webhookUniqueId} for Correlation ID: ${correlationIdValue}`);
					});

					// 5. Send Initial Request
					try {
						this.logger.debug(`Sending initial request [${itemIndex}] for ${webhookUniqueId} (Correlation: ${correlationIdValue})`);
						// Use this.helpers directly
						const initialResponse = await this.helpers.requestWithAuthentication(
							authentication,
							requestOptions,
							itemIndex,
						);
						// Log success, but response is ignored unless needed for debugging
						this.logger.debug(`Initial request [${itemIndex}] sent for ${webhookUniqueId}. Status: ${initialResponse?.statusCode}. Waiting for webhook...`);
					} catch (error: any) {
						// Clean up listener if initial request fails critically
						const listenerData = webhookListeners[webhookUniqueId];
						if (listenerData) {
							clearTimeout(listenerData.timeoutTimer);
							delete webhookListeners[webhookUniqueId];
							this.logger.debug(`Webhook Listener Removed due to initial request error: ${webhookUniqueId}`);
						}

						// Re-throw unless ignoring response code AND it's a NodeApiError
						if (!options.ignoreResponseCode || !isNodeApiError(error)) {
							throw error;
						} else {
							// Log ignored error and proceed to wait for webhook
							this.logger.warn(`Initial request [${itemIndex}] failed but ignoring response code. Error: ${error.message}. Status: ${error.context?.statusCode}. Proceeding to wait for webhook ${webhookUniqueId}.`);
						}
					}

					// 6. Wait for Webhook Promise
					this.logger.debug(`Waiting for webhook ${webhookUniqueId}...`);
					const webhookResult = await waitPromise; // Awaits resolution from webhook handler

					// 7. Add webhook result to output
					returnData.push({ json: webhookResult, pairedItem: { item: itemIndex } });

				} else {
					// --- Standard HTTP Request (No Webhook Wait) ---
					let response: NodeExecutionWithMetadata; // Contains full response object from helper
					try {
						// Use this.helpers directly
						response = await this.helpers.requestWithAuthentication(
							authentication,
							requestOptions,
							itemIndex,
						);

						let responseData: any; // Final data to be put in json property
						let binaryPropertyName: string | undefined = undefined; // For binary output

						const responseBody = response.body; // Could be Buffer, string, object
						const isBuffer = Buffer.isBuffer(responseBody);

						// Handle formatting based on user choice OR full response
						if (!fullResponse) {
							if (responseFormat === 'file') {
								if (!isBuffer) throw new NodeOperationError(node, 'Response body is not binary, cannot format as file.', { itemIndex });
								const headers = response.headers as IDataObject | undefined; // Assert type
								const mimeType = headers?.['content-type']?.split(';')[0] || 'application/octet-stream';
								// Use this.helpers directly
								const binaryData = await this.helpers.prepareBinaryData(responseBody, undefined, mimeType);
								binaryPropertyName = 'data'; // Standard n8n binary property name
								returnData.push({ json: {}, binary: { [binaryPropertyName]: binaryData }, pairedItem: { item: itemIndex } });
								continue; // Skip standard return push

							} else if (responseFormat === 'text') {
								const encoding = reqOptsAny.encoding as BufferEncoding | undefined; // Use encoding from options
								responseData = isBuffer ? responseBody.toString(encoding) : String(responseBody);
							} else if (responseFormat === 'json') {
								if (typeof responseBody === 'object' && !isBuffer) {
									responseData = responseBody; // Already parsed by helper
								} else {
									const encoding = reqOptsAny.encoding as BufferEncoding | undefined ?? 'utf8'; // Default UTF8 for JSON parsing
									const textBody = isBuffer ? responseBody.toString(encoding) : String(responseBody);
									try { responseData = JSON.parse(textBody); }
									catch (e: any) { throw new NodeOperationError(node, `Response body not valid JSON: ${e.message}`, { itemIndex }); }
								}
							} else { // Autodetect
								if (typeof responseBody === 'object' && !isBuffer) {
									responseData = responseBody; // Assume JSON if object
								} else {
									// Decode as text, default UTF8 if not specified
									const encoding = reqOptsAny.encoding as BufferEncoding | undefined ?? 'utf8';
									responseData = isBuffer ? responseBody.toString(encoding) : String(responseBody);
									// Optional: If content-type suggests JSON, try parsing
									const headers = response.headers as IDataObject | undefined; // Assert type
                                    if (headers?.['content-type']?.includes('json') && typeof responseData === 'string') {
                                        try { responseData = JSON.parse(responseData); } catch(e) { /* Ignore if parse fails */ }
                                    }
								}
							}
						} else { // Full Response requested
							let processedBody = responseBody;
							if (isBuffer) {
                                const headers = response.headers as IDataObject | undefined; // Assert type
                                const bufferInfo = `Buffer data (length: ${responseBody.length}, type: ${headers?.['content-type']})`;
								processedBody = bufferInfo;
							}
							responseData = {
								headers: response.headers,
								statusCode: response.statusCode,
								statusMessage: response.statusMessage,
								body: processedBody, // Include the potentially processed body
							};
						}

						// Add the result (unless binary was already handled)
						if (binaryPropertyName === undefined) {
							returnData.push({ json: responseData, pairedItem: { item: itemIndex } });
						}

					} catch (error: any) {
						// Handle errors, especially ignored ones
						if (!options.ignoreResponseCode || !isNodeApiError(error)) {
							throw error; // Re-throw if not ignoring or not standard API error
						}

						// Format ignored error for output
						const errorContext = error.context as IDataObject ?? {}; // Assert type or default
						const errorOutput: IDataObject = { // Ensure errorOutput is IDataObject
							error: {
								message: error.message,
								// stack: Handled below with type check
								httpCode: errorContext.statusCode,
								httpMessage: errorContext.statusMessage,
								headers: errorContext.headers,
								body: errorContext.body, // Body might be included in error context
							},
						};
                        // Safely add stack
                        if (error.stack && typeof error.stack === 'string') {
                           (errorOutput.error as IDataObject).stack = error.stack.split('\n').map((l: string) => l.trim());
                        }

						returnData.push({ json: errorOutput, pairedItem: { item: itemIndex } });
					}
				} // End of standard request block

			} catch (error: any) {
				// Handle errors for the item loop (respect continueOnFail)
				if (this.continueOnFail()) { // Use the method here
					const errorJson: IDataObject = { error: { message: error.message } };
					// Safely add stack and context
					if (error.stack && typeof error.stack === 'string') errorJson.error.stack = error.stack.split('\n').map((l: string) => l.trim());
					if (error instanceof NodeOperationError && error.context) errorJson.error.context = error.context;
					else if (isNodeApiError(error) && error.context) errorJson.error.context = error.context;

					// Ensure pairedItem is included for correct mapping
					returnData.push({ json: errorJson, pairedItem: { item: itemIndex } });
					continue; // Continue to next item
				}
				// If not continuing, re-throw the error
				throw error;
			}
		} // End of item loop

		return [returnData]; // Return data wrapped in array
	}


	// --- Webhook Method ---
	// 'this' context is IWebhookFunctions
	static async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> { // Use IWebhookResponseData for return type flexibility
		const req = this.getRequestObject() as IWebhookRequestObject; // Cast for convenience
		const node = this.getNode(); // Get node context

		// Extract unique ID from path parameter (defined as ':webhookId' in description)
		const webhookUniqueId = req.params?.webhookId as string | undefined;

		if (!webhookUniqueId) {
			this.logger.warn(`Webhook received without 'webhookId' in path parameters.`);
			// Signal error to n8n core to send appropriate response (e.g., 400)
			throw new NodeOperationError(node, 'Missing webhook identifier in URL path.');
		}

		this.logger.debug(`Webhook received for ID: ${webhookUniqueId}`);

		// Retrieve listeners from static data
		const staticData = this.getWorkflowStaticData('node');
		// Ensure listeners object exists in staticData
		const webhookListeners = staticData.listeners as { [key: string]: IWebhookListener } || {};
		const listenerData = webhookListeners[webhookUniqueId];

		if (!listenerData) {
			this.logger.warn(`Webhook received for unknown or timed-out listener ID: ${webhookUniqueId}. Ignoring.`);
			// Throw an error to signal failure (e.g., n8n sends 404 or 500)
            throw new NodeOperationError(node, `Webhook listener not found or timed out for ID: ${webhookUniqueId}`);
		}

		// Destructure listener data
		const { resolve, reject, timeoutTimer, expectedMethod, correlationId, webhookConfig, itemIndex } = listenerData;

		// Check HTTP Method
		const receivedMethod = (req.method ?? '').toUpperCase();
		if (receivedMethod !== expectedMethod) {
			this.logger.warn(`Webhook ${webhookUniqueId}: Method mismatch. Received ${receivedMethod}, expected ${expectedMethod}. Ignoring.`);
			// Throw error to signal method not allowed (n8n might send 405)
            throw new NodeOperationError(node, `Incorrect HTTP method ${receivedMethod} used for webhook ${webhookUniqueId}. Expected ${expectedMethod}.`, { itemIndex });
		}

		try {
			// Extract Correlation ID from incoming webhook
			const receivedCorrelationId = AsyncHttpRequest.handleCorrelationData(
				webhookConfig.correlationIdLocationInWebhook,
				webhookConfig.correlationIdParameterNameInWebhook as string,
				req, // Pass webhook request object
				undefined, // Not setting a value
				true, // isWebhookRequest = true
				node, // Pass node context
			) as string | undefined;

			this.logger.debug(`Webhook ${webhookUniqueId}: Expecting Correlation ID: ${correlationId}, Received: ${receivedCorrelationId}`);

			// Validate Correlation ID
			if (receivedCorrelationId === correlationId) {
				clearTimeout(timeoutTimer); // Stop timeout timer
				delete webhookListeners[webhookUniqueId]; // Clean up listener
				// NOTE: Persisting staticData changes might require an explicit call if necessary,
				// but usually modifying the retrieved object reference is sufficient for the current execution.
				this.logger.info(`Webhook ${webhookUniqueId}: Correlation ID match! Resolving promise.`);

				// Construct response data based on config
				const webhookResult: IDataObject = {};
				const includes = Array.isArray(webhookConfig.webhookResponseIncludes) ? webhookConfig.webhookResponseIncludes : ['body'];

				// Assign data, accepting 'unknown' for body
				if (includes.includes('body')) webhookResult.body = req.body;
				if (includes.includes('headers')) webhookResult.headers = req.headers;
				if (includes.includes('query')) webhookResult.query = req.query;

				resolve(webhookResult); // Resolve the waiting execute promise

				// Signal success to n8n core (sends 200 OK by default based on webhook definition)
				return { noWebhookResponse: false }; // Explicitly allow webhook response

			} else {
				// Correlation ID mismatch - log and ignore, keep listener active
				this.logger.warn(`Webhook ${webhookUniqueId}: Correlation ID mismatch. Expected ${correlationId}, got ${receivedCorrelationId}. Ignoring call.`);
				// Throw an error to signal the mismatch clearly (n8n might send 400 or 404 depending on interpretation)
                throw new NodeOperationError(node, `Correlation ID mismatch for webhook ${webhookUniqueId}.`, { itemIndex });
			}
		} catch (error: any) {
			// Error during webhook processing (e.g., extracting ID, correlation mismatch error)
			this.logger.error(`Webhook ${webhookUniqueId}: Error processing webhook: ${error.message}`, { error: error.stack });

            // Check if listener still exists before cleaning up (it might have been removed by timeout already)
            if (webhookListeners[webhookUniqueId]) {
			    clearTimeout(timeoutTimer);
			    delete webhookListeners[webhookUniqueId];
                 // Reject the promise only if the error wasn't the explicit mismatch error thrown above
                 if (!(error instanceof NodeOperationError && error.message.includes('Correlation ID mismatch'))) {
                    reject(new NodeOperationError(node, `Error processing webhook ${webhookUniqueId}: ${error.message}`, { itemIndex }));
                 }
            }


			// Re-throw the error so n8n core sends an error response (e.g., 500)
			throw error;
		}
	} // End of webhook method
} // End of class AsyncHttpRequest
