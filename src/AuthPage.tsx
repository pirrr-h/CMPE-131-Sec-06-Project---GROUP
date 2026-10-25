import { useState } from 'react';
import { Alert, Button, Card, Form } from 'react-bootstrap';
import { supabase } from './supabaseClient';
import { validateConfirmPassword, validateEmail, validateName, validatePassword,} from '../shared/authValidation';

type Field = 'name' | 'email' | 'password' | 'confirm';
type Errors = { name?: string; email?: string; password?: string; confirm?: string; };

export default function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isSignup = mode === 'signup';

  function update(field: Field, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
    setServerError(null);
  }

  function validate(): Errors {
    const found: Errors = {};
    const email = validateEmail(form.email);
    if (email) found.email = email;
    const password = validatePassword(form.password);
    if (password) found.password = password;
    if (isSignup) {
      const name = validateName(form.name);
      if (name) found.name = name;
      const confirm = validateConfirmPassword(form.password, form.confirm);
      if (confirm) found.confirm = confirm;
    }
    return found;
  }

  async function handleSubmit() {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setLoading(true);
    setServerError(null);
    try {
      const { error } = isSignup
        ? await supabase.auth.signUp({
            email: form.email,
            password: form.password,
            options: { data: { full_name: form.name.trim() } },
          })
        : await supabase.auth.signInWithPassword({ email: form.email, password: form.password });
      if (error) setServerError(error.message);
    } catch {
      setServerError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  function switchMode() {
    setMode(isSignup ? 'login' : 'signup');
    setErrors({});
    setServerError(null);
  }
  
  const field = (name: Field, label: string, type: string) => (
    <Form.Group className="mb-3" controlId={name}>
      <Form.Label>{label}</Form.Label>
      <Form.Control
        type={type}
        value={form[name]}
        onChange={(e) => update(name, e.target.value)}
        isInvalid={!!errors[name]}
        disabled={loading}
      />
      <Form.Control.Feedback type="invalid">{errors[name]}</Form.Control.Feedback>
    </Form.Group>
  );

  return (
    <Card className="mx-auto mt-5 p-4" style={{ maxWidth: 400 }}>
      <h2 className="mb-3">{isSignup ? 'Create your Poolr account' : 'Log in to Poolr'}</h2>
      <Form noValidate onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        {isSignup && field('name', 'Full name', 'text')}
        {field('email', 'Email', 'email')}
        {field('password', 'Password', 'password')}
        {isSignup && field('confirm', 'Confirm password', 'password')}
        {serverError && <Alert variant="danger">{serverError}</Alert>}
        <Button type="submit" className="w-100" disabled={loading}>
          {loading ? 'Please wait...' : isSignup ? 'Sign up' : 'Log in'}
        </Button>
      </Form>
      <Button variant="link" className="mt-2" onClick={switchMode} disabled={loading}>
        {isSignup ? 'Have an account? Log in' : 'No account? Sign up'}
      </Button>
    </Card>
  );
}