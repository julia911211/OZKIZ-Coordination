import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'https://gleqldxhdvkujeqdfbnbm.supabase.co'
const supabaseKey = 'sb_publishable_YvO5gS9CBjm9oIuGLnPxdg_XK_iPC2I'

export const supabase = createClient(supabaseUrl, supabaseKey)
