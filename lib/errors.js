export class ReviewError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReviewError'
    this.code = code
  }
}

export const issue = (code, message) => ({ code, message })
