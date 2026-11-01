import { Global, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestIdMiddleware } from '#core/context/request-id.middleware.ts';
import { AppLogger } from './app-logger.ts';
import { HttpLoggingMiddleware } from './http-logging.middleware.ts';
import { ResponseBodyInterceptor } from './response-body.interceptor.ts';

// RequestIdMiddleware and HttpLoggingMiddleware.trackResponse are also
// registered before the body parser in configureHttp (core/http), so they are
// providers here and can be fetched from the application.
@Global()
@Module({
  providers: [
    AppLogger,
    RequestIdMiddleware,
    HttpLoggingMiddleware,
    { provide: APP_INTERCEPTOR, useClass: ResponseBodyInterceptor },
  ],
  exports: [AppLogger, RequestIdMiddleware, HttpLoggingMiddleware],
})
export class LoggingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Runs after the body parser, so the request line includes the parsed body.
    consumer.apply(HttpLoggingMiddleware).forRoutes('{*path}');
  }
}
