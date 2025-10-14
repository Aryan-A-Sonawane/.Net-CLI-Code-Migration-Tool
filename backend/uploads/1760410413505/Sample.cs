using System;
using System.Web;

namespace SampleApp
{
    public class Program
    {
        public void MyMethod()
        {
            var context = HttpContext.Current; // Deprecated in .NET 8
            Console.WriteLine(context?.User.Identity.Name);
        }

        public class MyNestedClass
        {
            public void AnotherMethod()
            {
                var context = HttpContext.Current; // Another instance
            }
        }
    }
}