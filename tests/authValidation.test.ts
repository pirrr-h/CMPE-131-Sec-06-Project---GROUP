import {
  validateConfirmPassword,
  validateEmail,
  validateName,
  validatePassword,
} from '../shared/authValidation';

describe('validateEmail', () => {
  test('rejects an empty email', () => {
    expect(validateEmail('')).toBe('Email is required');
  });
  test('rejects spaces only', () => {
    expect(validateEmail('   ')).toBe('Email is required');
  });
  test('rejects an email with no domain', () => {
    expect(validateEmail('name@')).toBe('Enter a valid email');
  });
  test('accepts a normal email', () => {
    expect(validateEmail('name@sjsu.edu')).toBeNull();
  });
});

describe('validatePassword', () => {
  test('rejects 7 characters', () => {
    expect(validatePassword('1234567')).toBe('Password must be at least 8 characters');
  });
  test('accepts 8 characters', () => {
    expect(validatePassword('12345678')).toBeNull();
  });
});

describe('validateName', () => {
  test('rejects an empty name', () => {
    expect(validateName('  ')).toBe('Name is required');
  });
  test('accepts a name', () => {
    expect(validateName('Indervir')).toBeNull();
  });
});

describe('validateConfirmPassword', () => {
  test('rejects an empty confirm box', () => {
    expect(validateConfirmPassword('password1', '')).toBe('Please confirm your password');
  });
  test('rejects mismatched passwords', () => {
    expect(validateConfirmPassword('password1', 'password2')).toBe('Passwords do not match');
  });
  test('accepts matching passwords', () => {
    expect(validateConfirmPassword('password1', 'password1')).toBeNull();
  });
});