import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
  } from 'n8n-workflow';
  import { OptionsWithUri } from 'request-promise-native';
  import { BINARY_ENCODING, jsonParse } from 'n8n-workflow';
  import * as crypto from 'crypto';
  
  
  export class HttpWebhookRequest implements INodeType {
	description: INodeTypeDescription = {
	  displayName: 'HTTP Webhook Request',
	  name: 'httpWebhookRequest',
	  icon: 'fa:exchange-alt',
	  group: ['output'],
	  version: 1,
	  subtitle: '={{$parameter["method"] + ": " + $parameter["url"]}}',
	  description: 'Makes an HTTP request and waits for webhook response',
	  defaults: {
		name: 'HTTP Webhook Request',
		color: '#2200DD',
	  },
	  inputs: ['main'],
	  outputs: ['main'],
	  credentials: [
		{
		  name: 'httpBasicAuth',
		  required: false,
		  displayOptions: {
			show: {
			  authentication: ['basicAuth'],
			},
		  },
		},
		{
		  name: 'httpDigestAuth',
		  required: false,
		  displayOptions: {
			show: {
			  authentication: ['digestAuth'],
			},
		  },
		},
		{
		  name: 'httpHeaderAuth',
		  required: false,
		  displayOptions: {
			show: {
			  authentication: ['headerAuth'],
			},
		  },
		},
		{
		  name: 'httpQueryAuth',
		  required: false,
		  displayOptions: {
			show: {
			  authentication: ['queryAuth'],
			},
		  },
		},
		{
		  name: 'oAuth1Api',
		  required: false,
		  displayOptions: {
			show: {
			  authentication: ['oAuth1'],
			},
		  },
		},
		{
		  name: 'oAuth2Api',
		  required: false,
		  displayOptions: {
			show: {
			  authentication: ['oAuth2'],
			},
		  },
		},
	  ],
	  properties: [
		{
		  displayName: 'Method',
		  name: 'method',
		  type: 'options',
		  options: [
			{
			  name: 'DELETE',
			  value: 'DELETE',
			},
			{
			  name: 'GET',
			  value: 'GET',
			},
			{
			  name: 'HEAD',
			  value: 'HEAD',
			},
			{
			  name: 'OPTIONS',
			  value: 'OPTIONS',
			},
			{
			  name: 'PATCH',
			  value: 'PATCH',
			},
			{
			  name: 'POST',
			  value: 'POST',
			},
			{
			  name: 'PUT',
			  value: 'PUT',
			},
		  ],
		  default: 'GET',
		  description: 'The request method to use',
		},
		{
		  displayName: 'URL',
		  name: 'url',
		  type: 'string',
		  default: '',
		  placeholder: 'http://example.com/index.html',
		  description: 'The URL to make the request to',
		  required: true,
		},
		{
		  displayName: 'Wait For Webhook Response',
		  name: 'waitForWebhook',
		  type: 'boolean',
		  default: true,
		  description: 'Whether to wait for response via webhook',
		},
		{
		  displayName: 'Webhook Timeout',
		  name: 'webhookTimeout',
		  type: 'number',
		  displayOptions: {
			show: {
			  waitForWebhook: [true],
			},
		  },
		  default: 300,
		  description: 'Maximum time (in seconds) to wait for webhook response',
		},
		{
		  displayName: 'Webhook Correlation Field',
		  name: 'webhookCorrelationField',
		  type: 'string',
		  displayOptions: {
			show: {
			  waitForWebhook: [true],
			},
		  },
		  default: 'requestId',
		  description: 'Field in webhook payload used to correlate with original request',
		},
		{
		  displayName: 'Webhook Correlation Value From',
		  name: 'webhookCorrelationValueFrom',
		  type: 'options',
		  displayOptions: {
			show: {
			  waitForWebhook: [true],
			},
		  },
		  options: [
			{
			  name: 'Random ID',
			  value: 'random',
			},
			{
			  name: 'Response Field',
			  value: 'responseField',
			},
			{
			  name: 'Custom Value',
			  value: 'custom',
			},
		  ],
		  default: 'random',
		  description: 'How to determine the correlation value',
		},
		{
		  displayName: 'Response Field',
		  name: 'responseField',
		  type: 'string',
		  displayOptions: {
			show: {
			  waitForWebhook: [true],
			  webhookCorrelationValueFrom: ['responseField'],
			},
		  },
		  default: 'id',
		  description: 'Field in initial response to use as correlation value',
		},
		{
		  displayName: 'Correlation Value',
		  name: 'correlationValue',
		  type: 'string',
		  displayOptions: {
			show: {
			  waitForWebhook: [true],
			  webhookCorrelationValueFrom: ['custom'],
			},
		  },
		  default: '',
		  description: 'Custom value to use for correlation',
		},
		{
		  displayName: 'Authentication',
		  name: 'authentication',
		  type: 'options',
		  options: [
			{
			  name: 'None',
			  value: 'none',
			},
			{
			  name: 'Basic Auth',
			  value: 'basicAuth',
			},
			{
			  name: 'Digest Auth',
			  value: 'digestAuth',
			},
			{
			  name: 'Header Auth',
			  value: 'headerAuth',
			},
			{
			  name: 'Query Auth',
			  value: 'queryAuth',
			},
			{
			  name: 'OAuth1',
			  value: 'oAuth1',
			},
			{
			  name: 'OAuth2',
			  value: 'oAuth2',
			},
		  ],
		  default: 'none',
		  description: 'The authentication to use',
		},
		{
		  displayName: 'Send Headers',
		  name: 'sendHeaders',
		  type: 'boolean',
		  default: false,
		  description: 'Whether to send custom headers',
		},
		{
		  displayName: 'Headers',
		  name: 'headerParameters',
		  type: 'collection',
		  displayOptions: {
			show: {
			  sendHeaders: [true],
			},
		  },
		  placeholder: 'Add Header',
		  default: {},
		  options: [
			{
			  displayName: 'Header',
			  name: 'parameter',
			  type: 'string',
			  default: '',
			  description: 'Header parameters to include in the request',
			},
		  ],
		},
		{
		  displayName: 'Query Parameters',
		  name: 'queryParameters',
		  type: 'collection',
		  placeholder: 'Add Parameter',
		  default: {},
		  options: [
			{
			  displayName: 'Parameter',
			  name: 'parameter',
			  type: 'string',
			  default: '',
			  description: 'Query parameters to include in the request',
			},
		  ],
		},
		{
		  displayName: 'Body Content Type',
		  name: 'bodyContentType',
		  type: 'options',
		  displayOptions: {
			show: {
			  method: ['PATCH', 'POST', 'PUT'],
			},
		  },
		  options: [
			{
			  name: 'JSON',
			  value: 'json',
			},
			{
			  name: 'Form-Data Multipart',
			  value: 'multipart-form-data',
			},
			{
			  name: 'Form-Encoded',
			  value: 'form-urlencoded',
			},
			{
			  name: 'Raw',
			  value: 'raw',
			},
			{
			  name: 'Binary',
			  value: 'binaryData',
			},
		  ],
		  default: 'json',
		  description: 'Content-Type to use to send body parameters',
		},
		{
		  displayName: 'Body Parameters',
		  name: 'bodyParameters',
		  type: 'collection',
		  displayOptions: {
			show: {
			  method: ['PATCH', 'POST', 'PUT'],
			  bodyContentType: ['json', 'multipart-form-data', 'form-urlencoded'],
			},
		  },
		  placeholder: 'Add Parameter',
		  default: {},
		  options: [
			{
			  displayName: 'Parameter',
			  name: 'parameter',
			  type: 'string',
			  default: '',
			  description: 'Body parameters to include in the request',
			},
		  ],
		},
		{
		  displayName: 'Raw Body',
		  name: 'rawBody',
		  type: 'string',
		  displayOptions: {
			show: {
			  method: ['PATCH', 'POST', 'PUT'],
			  bodyContentType: ['raw'],
			},
		  },
		  default: '',
		  description: 'Body parameters to include in the request (raw)',
		},
		{
		  displayName: 'Binary Property',
		  name: 'binaryPropertyName',
		  type: 'string',
		  default: 'data',
		  displayOptions: {
			show: {
			  method: ['PATCH', 'POST', 'PUT'],
			  bodyContentType: ['binaryData'],
			},
		  },
		  description: 'Name of the binary property to send as body',
		},
		{
		  displayName: 'Response Format',
		  name: 'responseFormat',
		  type: 'options',
		  options: [
			{
			  name: 'Automatically Detect',
			  value: 'autodetect',
			},
			{
			  name: 'String',
			  value: 'string',
			},
			{
			  name: 'JSON',
			  value: 'json',
			},
			{
			  name: 'Binary',
			  value: 'file',
			},
		  ],
		  default: 'autodetect',
		  description: 'The format in which the data gets returned from the URL',
		},
		{
		  displayName: 'Response Property',
		  name: 'responsePropertyName',
		  type: 'string',
		  default: 'data',
		  displayOptions: {
			show: {
			  responseFormat: ['file'],
			},
		  },
		  description: 'Name of the binary property to which to write the response data',
		},
		{
		  displayName: 'Options',
		  name: 'options',
		  type: 'collection',
		  placeholder: 'Add Option',
		  default: {},
		  options: [
			{
			  displayName: 'Proxy',
			  name: 'proxy',
			  type: 'string',
			  default: '',
			  placeholder: 'http://myproxy:3128',
			  description: 'HTTP proxy to use',
			},
			{
			  displayName: 'Timeout',
			  name: 'timeout',
			  type: 'number',
			  default: 10000,
			  description: 'Time in ms to wait for the server to send response headers before aborting the request',
			},
			{
			  displayName: 'Ignore SSL Issues',
			  name: 'allowSelfSignedCertificate',
			  type: 'boolean',
			  default: false,
			  description: 'Whether to ignore SSL certificates that are not authorized',
			},
			{
			  displayName: 'Follow Redirect',
			  name: 'followRedirect',
			  type: 'boolean',
			  default: true,
			  description: 'Whether to follow XML-RPC redirects',
			},
			{
			  displayName: 'Response Headers',
			  name: 'returnFullResponse',
			  type: 'boolean',
			  default: false,
			  description: 'Whether to return the full response data instead of only the body',
			},
			{
			  displayName: 'Limit',
			  name: 'limit',
			  type: 'number',
			  default: 0,
			  description: 'Max number of items to return',
			},
		  ],
		},
	  ],
	};
  
  
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	  const items = this.getInputData();
	  const returnItems: INodeExecutionData[] = [];
	  
	  let requestOptions: OptionsWithUri;
	  
	  const waitForWebhook = this.getNodeParameter('waitForWebhook', 0, false) as boolean;
	  
	  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
		  // Get connection information
		  const method = this.getNodeParameter('method', itemIndex, 'GET') as string;
		  const url = this.getNodeParameter('url', itemIndex, '') as string;
		  
		  // Generate a request ID for correlation if waiting for webhook
		  let correlationId = '';
		  if (waitForWebhook) {
			const correlationSource = this.getNodeParameter('webhookCorrelationValueFrom', itemIndex, 'random') as string;
			
			if (correlationSource === 'random') {
			  correlationId = crypto.randomUUID();
			} else if (correlationSource === 'custom') {
			  correlationId = this.getNodeParameter('correlationValue', itemIndex, '') as string;
			}
			// For responseField, we'll set it after the initial request
		  }
		  
		  // Build request options based on node parameters
		  requestOptions = this.prepareRequestOptions(method, url, itemIndex);
		  
		  // Apply correlation ID to the request if needed
		  if (waitForWebhook && correlationId) {
			// Determine where to add the correlation ID (headers, query, body)
			if (method === 'GET' || method === 'HEAD') {
			  // Add to query parameters for GET/HEAD
			  if (!requestOptions.qs) requestOptions.qs = {};
			  requestOptions.qs.requestId = correlationId;
			} else {
			  // Add to body for other methods if JSON
			  if (requestOptions.body && typeof requestOptions.body === 'object') {
				(requestOptions.body as any).requestId = correlationId;
			  } 
			  // Also add to headers as fallback
			  if (!requestOptions.headers) requestOptions.headers = {};
			  requestOptions.headers['X-Request-ID'] = correlationId;
			}
		  }
		  
		  // Make the HTTP request
		  let responseData;
		  
		  try {
			responseData = await this.helpers.request(requestOptions);
		  } catch (error) {
			throw new NodeOperationError(this.getNode(), `HTTP request failed: ${error.message}`, { itemIndex });
		  }
		  
		  // If response comes back as a string, try to parse it as JSON
		  if (typeof responseData === 'string') {
			try {
			  responseData = JSON.parse(responseData);
			} catch (e) {
			  // If it's not valid JSON, keep it as a string
			}
		  }
		  
		  // If we're not waiting for a webhook, return the response right away
		  if (!waitForWebhook) {
			returnItems.push({
			  json: responseData,
			  pairedItem: { item: itemIndex },
			});
			continue;
		  }
		  
		  // For webhook responses, we need to set up a waiting mechanism
		  const webhookTimeout = this.getNodeParameter('webhookTimeout', itemIndex, 300) as number;
		  const webhookCorrelationField = this.getNodeParameter('webhookCorrelationField', itemIndex, 'requestId') as string;
		  
		  // If correlation is from response field, extract it
		  if (correlationId === '' && this.getNodeParameter('webhookCorrelationValueFrom', itemIndex, 'random') === 'responseField') {
			const responseField = this.getNodeParameter('responseField', itemIndex, 'id') as string;
			if (responseData && typeof responseData === 'object' && responseField in responseData) {
			  correlationId = responseData[responseField].toString();
			} else {
			  throw new NodeOperationError(
				this.getNode(),
				`Could not find correlation field "${responseField}" in the response`,
				{ itemIndex }
			  );
			}
		  }
		  
		  // Now wait for the webhook with matching correlation ID
		  const webhookData = await this.waitForWebhookResponse(correlationId, webhookCorrelationField, webhookTimeout);
		  
		  if (webhookData === null) {
			throw new NodeOperationError(
			  this.getNode(),
			  `Webhook response timeout after ${webhookTimeout} seconds`,
			  { itemIndex }
			);
		  }
		  
		  // Return the webhook data instead of the original response
		  returnItems.push({
			json: {
			  initialResponse: responseData,
			  webhookResponse: webhookData,
			},
			pairedItem: { item: itemIndex },
		  });
		} catch (error) {
		  if (this.continueOnFail()) {
			returnItems.push({
			  json: {
				error: error.message,
			  },
			  pairedItem: { item: itemIndex },
			});
			continue;
		  }
		  throw error;
		}
	  }
	  
	  return [returnItems];
	}
	
	/**
	 * Prepare the request options based on node parameters
	 */
	private prepareRequestOptions(method: string, url: string, itemIndex: number): OptionsWithUri {
	  const options: OptionsWithUri = {
		method,
		uri: url,
		json: true,
		gzip: true,
	  };
	  
	  // Authentication
	  const authentication = this.getNodeParameter('authentication', itemIndex, 'none') as string;
	  
	  if (authentication === 'basicAuth') {
		const credentials = this.getCredentials('httpBasicAuth') as ICredentialDataDecryptedObject;
		options.auth = {
		  user: credentials.user as string,
		  pass: credentials.password as string,
		};
	  } else if (authentication === 'headerAuth') {
		const credentials = this.getCredentials('httpHeaderAuth') as ICredentialDataDecryptedObject;
		options.headers = {
		  [credentials.name as string]: credentials.value as string,
		};
	  } else if (authentication === 'oAuth1') {
		const credentials = this.getCredentials('oAuth1Api') as ICredentialDataDecryptedObject;
		const oauth = {
		  consumer_key: credentials.consumerKey as string,
		  consumer_secret: credentials.consumerSecret as string,
		  token: credentials.accessToken as string,
		  token_secret: credentials.accessSecret as string,
		};
		options.oauth = oauth;
	  } else if (authentication === 'oAuth2') {
		const credentials = this.getCredentials('oAuth2Api') as ICredentialDataDecryptedObject;
		options.headers = {
		  Authorization: `Bearer ${credentials.accessToken}`,
		};
	  }
	  
	  // Headers
	  const sendHeaders = this.getNodeParameter('sendHeaders', itemIndex, false) as boolean;
	  if (sendHeaders) {
		const headerParameters = this.getNodeParameter('headerParameters', itemIndex, {}) as {
		  parameter: { [key: string]: string };
		};
		
		if (!options.headers) options.headers = {};
		
		for (const key of Object.keys(headerParameters.parameter || {})) {
		  options.headers[key] = headerParameters.parameter[key];
		}
	  }
	  
	  // Query Parameters
	  const queryParameters = this.getNodeParameter('queryParameters', itemIndex, {}) as {
		parameter: { [key: string]: string };
	  };
	  
	  if (Object.keys(queryParameters.parameter || {}).length) {
		options.qs = {};
		
		for (const key of Object.keys(queryParameters.parameter || {})) {
		  options.qs[key] = queryParameters.parameter[key];
		}
	  }
	  
	  // Body Parameters
	  if (['PATCH', 'POST', 'PUT'].includes(method)) {
		const bodyContentType = this.getNodeParameter('bodyContentType', itemIndex, 'json') as string;
		
		if (bodyContentType === 'json') {
		  const bodyParameters = this.getNodeParameter('bodyParameters', itemIndex, {}) as {
			parameter: { [key: string]: string };
		  };
		  
		  options.body = {};
		  
		  for (const key of Object.keys(bodyParameters.parameter || {})) {
			options.body[key] = bodyParameters.parameter[key];
		  }
		} else if (bodyContentType === 'multipart-form-data') {
		  const bodyParameters = this.getNodeParameter('bodyParameters', itemIndex, {}) as {
			parameter: { [key: string]: string };
		  };
		  
		  const formData = {};
		  
		  for (const key of Object.keys(bodyParameters.parameter || {})) {
			formData[key] = bodyParameters.parameter[key];
		  }
		  
		  options.formData = formData;
		} else if (bodyContentType === 'form-urlencoded') {
		  const bodyParameters = this.getNodeParameter('bodyParameters', itemIndex, {}) as {
			parameter: { [key: string]: string };
		  };
		  
		  const form = {};
		  
		  for (const key of Object.keys(bodyParameters.parameter || {})) {
			form[key] = bodyParameters.parameter[key];
		  }
		  
		  options.form = form;
		} else if (bodyContentType === 'raw') {
		  options.body = this.getNodeParameter('rawBody', itemIndex, '') as string;
		} else if (bodyContentType === 'binaryData') {
		  const binaryPropertyName = this.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string;
		  const binaryData = this.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
		  
		  options.body = binaryData;
		}
	  }
	  
	  // Response Format
	  const responseFormat = this.getNodeParameter('responseFormat', itemIndex, 'autodetect') as string;
	  
	  if (responseFormat === 'file') {
		options.encoding = null;
		options.json = false;
	  } else if (responseFormat === 'string') {
		options.json = false;
	  }
	  
	  // Additional Options
	  const additionalOptions = this.getNodeParameter('options', itemIndex, {}) as {
		allowSelfSignedCertificate?: boolean;
		followRedirect?: boolean;
		proxy?: string;
		timeout?: number;
	  };
	  
	  if (additionalOptions.allowSelfSignedCertificate) {
		options.rejectUnauthorized = false;
	  }
	  
	  if (additionalOptions.followRedirect !== undefined) {
		options.followRedirect = additionalOptions.followRedirect;
	  }
	  
	  if (additionalOptions.proxy) {
		options.proxy = additionalOptions.proxy;
	  }
	  
	  if (additionalOptions.timeout) {
		options.timeout = additionalOptions.timeout;
	  }
	  
	  return options;
	}
	
	/**
	 * Wait for a webhook response with matching correlation ID
	 */
	private async waitForWebhookResponse(
	  correlationId: string,
	  correlationField: string,
	  timeoutSeconds: number
	): Promise<any> {
	  // This would be implemented with the n8n SDK to listen for webhook events
	  // This is a simplified placeholder implementation
	  
	  // Maintain a map of pending webhook requests by correlation ID
	  if (!this.pendingWebhooks) {
		this.pendingWebhooks = new Map<string, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }>();
	  }
	  
	  return new Promise<any>((resolve, reject) => {
		// Set a timeout to reject the promise if webhook doesn't arrive
		const timeout = setTimeout(() => {
		  this.pendingWebhooks.delete(correlationId);
		  resolve(null); // Return null on timeout instead of rejecting
		}, timeoutSeconds * 1000);
		
		// Store the promise handlers and timeout
		this.pendingWebhooks.set(correlationId, { resolve, reject, timeout });
		
		// In a real implementation, n8n would register a webhook listener
		// When a webhook is received, it would check if correlationId matches
		// and resolve the corresponding promise
		
		// For testing, you'd need to call the handleWebhook method manually
		// or implement a test webhook server
	  });
	}
	
	/**
	 * Handle an incoming webhook
	 * This method would be called by the n8n webhook handler
	 */
	public handleWebhook(webhookData: any, correlationField: string): boolean {
	  if (!this.pendingWebhooks || !webhookData || typeof webhookData !== 'object') {
		return false;
	  }
	  
	  const correlationId = webhookData[correlationField];
	  
	  if (!correlationId || !this.pendingWebhooks.has(correlationId)) {
		return false;
	  }
	  
	  const { resolve, timeout } = this.pendingWebhooks.get(correlationId);
	  
	  // Clear the timeout and resolve the promise with the webhook data
	  clearTimeout(timeout);
	  resolve(webhookData);
	  this.pendingWebhooks.delete(correlationId);
	  
	  return true;
	}
  }
  